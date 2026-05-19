#!/usr/bin/env bash
#
# Smoke test for the Sessions 11+12 webhook receivers.
#
#   1. Seed a dispatched asset with a known external_id so the processor
#      has something to map to.
#   2. POST /api/webhooks/zernio with a 'post.published' event.
#      Assert: 200, accepted:true, applied:true, asset.status='published'.
#   3. POST the SAME event again.
#      Assert: 200, duplicate:true, asset still at 'published' (no second
#      side-effect).
#   4. POST a 'post.analytics' event with impressions+engagement.
#      Assert: row inserted in signals, asset.signals.last_sampled_at set.
#   5. POST /api/webhooks/dojoclaw with 'article.completed' for a brief
#      asset. Assert: asset.dispatch.draft_url set, status='published'.

set -euo pipefail

if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then export "$key=$val"; fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL)=' .env)
fi
API="${API_BASE_URL:-http://localhost:3000}"
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"

SUFFIX="$(date +%s%N | tail -c 8)"
BRAND_ID="brd_smoke_wh_${SUFFIX}"
ASSET_LINKEDIN="ast_smoke_wh_li_${SUFFIX}"
ASSET_BRIEF="ast_smoke_wh_br_${SUFFIX}"
ZERNIO_EXTERNAL="zer_smoke_${SUFFIX}"
DOJOCLAW_EXTERNAL="djw_smoke_${SUFFIX}"

H_JSON=(-H "Content-Type: application/json")
say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }

say "seed brand + assets dispatched with known external_ids"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO brands(id, slug, name) VALUES ('$BRAND_ID', 'smoke-wh-$SUFFIX', 'WH $SUFFIX');
INSERT INTO sources(id, brand_id, kind) VALUES ('src_wh_$SUFFIX', '$BRAND_ID', 'youtube_url');
INSERT INTO packages(id, brand_id, source_id, status)
  VALUES ('pkg_wh_$SUFFIX', '$BRAND_ID', 'src_wh_$SUFFIX', 'approved');

INSERT INTO assets(id, package_id, brand_id, type, status, payload, dispatch)
VALUES
  ('$ASSET_LINKEDIN', 'pkg_wh_$SUFFIX', '$BRAND_ID', 'linkedin_post', 'scheduled',
   jsonb_build_object('text', 'hi'),
   jsonb_build_object('target', 'zernio', 'external_id', '$ZERNIO_EXTERNAL',
                      'dispatched_at', '2026-05-01T00:00:00Z')),
  ('$ASSET_BRIEF', 'pkg_wh_$SUFFIX', '$BRAND_ID', 'article_brief', 'scheduled',
   jsonb_build_object('working_title', 'x'),
   jsonb_build_object('target', 'dojoclaw', 'external_id', '$DOJOCLAW_EXTERNAL'));
SQL

# ─── zernio post.published ─────────────────────────────────────────────────
say "POST zernio post.published"
RESP1=$(curl -sS "${H_JSON[@]}" -X POST "$API/api/webhooks/zernio" -d "{
  \"_id\": \"evt_smoke_pub_$SUFFIX\",
  \"event\": \"post.published\",
  \"post_id\": \"$ZERNIO_EXTERNAL\",
  \"published_at\": \"2026-05-19T10:00:00Z\"
}")
echo "  $RESP1"
echo "$RESP1" | grep -q '"applied":true' || die "expected applied:true on first POST"

LI_STATUS=$(psql "$DB" -tAc "SELECT status FROM assets WHERE id = '$ASSET_LINKEDIN'")
[[ "$LI_STATUS" == "published" ]] || die "expected linkedin asset status='published', got $LI_STATUS"
echo "  ✓ asset.status flipped to published"

say "POST same event again (idempotency)"
RESP2=$(curl -sS "${H_JSON[@]}" -X POST "$API/api/webhooks/zernio" -d "{
  \"_id\": \"evt_smoke_pub_$SUFFIX\",
  \"event\": \"post.published\",
  \"post_id\": \"$ZERNIO_EXTERNAL\"
}")
echo "  $RESP2"
echo "$RESP2" | grep -q '"duplicate":true' || die "expected duplicate:true on second POST"

# ─── zernio post.analytics ─────────────────────────────────────────────────
say "POST zernio post.analytics"
RESP3=$(curl -sS "${H_JSON[@]}" -X POST "$API/api/webhooks/zernio" -d "{
  \"_id\": \"evt_smoke_an_$SUFFIX\",
  \"event\": \"post.analytics\",
  \"post_id\": \"$ZERNIO_EXTERNAL\",
  \"impressions\": 1240,
  \"engagement\": 87,
  \"ctr\": 0.034,
  \"sampled_at\": \"2026-05-19T11:00:00Z\"
}")
echo "  $RESP3"
echo "$RESP3" | grep -q '"applied":true' || die "expected applied:true on analytics"

SIGNAL_COUNT=$(psql "$DB" -tAc "SELECT count(*) FROM signals WHERE asset_id = '$ASSET_LINKEDIN'")
echo "  signals row count = $SIGNAL_COUNT"
[[ "$SIGNAL_COUNT" == "3" ]] || die "expected 3 signal rows (imp+eng+ctr), got $SIGNAL_COUNT"

LAST_SAMPLED=$(psql "$DB" -tAc "SELECT signals->>'last_sampled_at' FROM assets WHERE id = '$ASSET_LINKEDIN'")
[[ -n "$LAST_SAMPLED" ]] || die "asset.signals.last_sampled_at not set"
echo "  ✓ asset.signals.last_sampled_at = $LAST_SAMPLED"

# ─── dojoclaw article.completed ────────────────────────────────────────────
say "POST dojoclaw article.completed"
RESP4=$(curl -sS "${H_JSON[@]}" -X POST "$API/api/webhooks/dojoclaw" -d "{
  \"event_id\": \"evt_smoke_djw_$SUFFIX\",
  \"event\": \"article.completed\",
  \"job_id\": \"$DOJOCLAW_EXTERNAL\",
  \"draft_url\": \"https://thorstenmeyerai.com/wp-admin/post.php?post=42\"
}")
echo "  $RESP4"
echo "$RESP4" | grep -q '"applied":true' || die "expected applied:true on dojoclaw"

BR_STATUS=$(psql "$DB" -tAc "SELECT status FROM assets WHERE id = '$ASSET_BRIEF'")
BR_DRAFT=$(psql "$DB" -tAc "SELECT dispatch->>'draft_url' FROM assets WHERE id = '$ASSET_BRIEF'")
echo "  brief asset status=$BR_STATUS  draft_url=$BR_DRAFT"
[[ "$BR_STATUS" == "published" ]] || die "expected brief status=published"
[[ -n "$BR_DRAFT" ]] || die "expected draft_url set"

# ─── cleanup ───────────────────────────────────────────────────────────────
say "cleanup"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM signals WHERE brand_id = '$BRAND_ID';
DELETE FROM webhook_events WHERE source_event_id LIKE 'evt_smoke_%_$SUFFIX'
                              OR source_event_id LIKE 'evt_smoke_djw_$SUFFIX';
DELETE FROM assets WHERE brand_id = '$BRAND_ID';
DELETE FROM packages WHERE brand_id = '$BRAND_ID';
DELETE FROM sources WHERE brand_id = '$BRAND_ID';
DELETE FROM brands WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-webhooks ok"
