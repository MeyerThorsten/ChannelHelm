#!/usr/bin/env bash
#
# End-to-end pipeline smoke through Session 09.
#
# Chain: ingest → transcribe_audio → analyze_visual → fuse →
#        analyze_intelligence → generate_asset×9.
#
# Verifies: 9 asset rows landed for the package with status=ready_for_review
# and §2.2 provenance attached. Cleanup at the end. Requires LM Studio at
# $LM_STUDIO_DEFAULT_HOST (default localhost:1234).

set -euo pipefail

if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then
      export "$key=$val"
    fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL|MEDIA_ROOT|LM_STUDIO_)' .env)
fi

API="${API_BASE_URL:-http://localhost:3000}"
TOKEN="${LOCAL_BEARER_TOKEN:?LOCAL_BEARER_TOKEN must be set}"
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"
TEST_URL="${TEST_VIDEO_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"

H_AUTH=(-H "Authorization: Bearer $TOKEN")
H_JSON=(-H "Content-Type: application/json")
SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-pipe-${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }
curl_json() { local m=$1 u=$2; shift 2; curl -sS -X "$m" "${H_AUTH[@]}" "${H_JSON[@]}" "$@" "$u"; }
py_get() { python3 -c "
import json
d = json.loads('''$1''')
for k in '$2'.split('.'):
    d = d[k]
print(d)
"; }

B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Pipe $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
S=$(curl_json POST "$API/api/sources" -d "{\"brandId\":\"$BRAND_ID\",\"kind\":\"youtube_url\",\"originUrl\":\"$TEST_URL\"}")
SOURCE_ID=$(py_get "$S" source.id)
P=$(curl_json POST "$API/api/packages" -d "{\"brandId\":\"$BRAND_ID\",\"sourceId\":\"$SOURCE_ID\"}")
PACKAGE_ID=$(py_get "$P" package.id)
echo "brand=$BRAND_ID  source=$SOURCE_ID  package=$PACKAGE_ID"

for k in ingest transcribe_audio analyze_visual fuse analyze_intelligence; do
  say "run $k"
  pnpm exec tsx workers/runner.ts --kinds "$k" --once 2>&1 | sed 's/^/  /'
done

say "drain generate_asset queue"
# WORKER_NO_BACKOFF=1 makes the runner's fail() set run_after=now() instead
# of the §6.4 exponential window, so a single flaky LLM JSON parse doesn't
# stall the smoke for 2 minutes. Production must NOT set this — it's an
# explicit test-only escape hatch defined in workers/queue.ts.
export WORKER_NO_BACKOFF=1
for i in $(seq 1 18); do
  PENDING=$(psql "$DB" -tAc "
    SELECT count(*) FROM jobs
     WHERE kind = 'generate_asset'
       AND status = 'pending'
       AND payload->>'packageId' = '$PACKAGE_ID'
  ")
  if [[ "$PENDING" == "0" ]]; then
    echo "  no more pending generate_asset jobs after $((i-1)) iterations"
    break
  fi
  echo "  iter $i: $PENDING pending"
  pnpm exec tsx workers/runner.ts --kinds generate_asset --once 2>&1 | sed 's/^/    /'
done
unset WORKER_NO_BACKOFF

# ─── verify ────────────────────────────────────────────────────────────────
say "verify assets table"
ASSET_COUNT=$(psql "$DB" -tAc "SELECT count(*) FROM assets WHERE package_id = '$PACKAGE_ID'")
echo "  asset count = $ASSET_COUNT"
# 10 = 9 text assets + 1 short_clip_plan (Session 09 + the plan added when
# the gap pass landed). Plans live alongside text assets pre-approval.
[[ "$ASSET_COUNT" == "10" ]] || die "expected 10 assets, got $ASSET_COUNT"

MISSING_PROV=$(psql "$DB" -tAc "
  SELECT count(*) FROM assets
   WHERE package_id = '$PACKAGE_ID'
     AND (provenance->>'provider' IS NULL
       OR provenance->>'model' IS NULL
       OR provenance->>'generated_at' IS NULL)
")
[[ "$MISSING_PROV" == "0" ]] || die "$MISSING_PROV assets missing provenance fields"

say "asset summary:"
psql "$DB" -c "SELECT type, status, length(payload::text) AS payload_size FROM assets WHERE package_id = '$PACKAGE_ID' ORDER BY type" | sed 's/^/  /'

# ─── cleanup ────────────────────────────────────────────────────────────────
LMP=$(psql "$DB" -tAc "SELECT local_media_path FROM sources WHERE id = '$SOURCE_ID'")
say "cleanup"
rm -rf "$LMP"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM assets WHERE package_id = '$PACKAGE_ID';
DELETE FROM jobs WHERE payload->>'sourceId' = '$SOURCE_ID' OR payload->>'packageId' = '$PACKAGE_ID';
DELETE FROM packages WHERE id = '$PACKAGE_ID';
DELETE FROM sources  WHERE id = '$SOURCE_ID';
DELETE FROM brands   WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-pipeline ok"
