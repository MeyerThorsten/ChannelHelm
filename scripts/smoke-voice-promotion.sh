#!/usr/bin/env bash
#
# Smoke test for the Session 17 promote_voice_examples worker.
# Pure DB — no LLM, no media. Injects synthetic assets + signals via
# psql, runs the worker, asserts voice_examples got populated.

set -euo pipefail

if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then export "$key=$val"; fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL)=' .env)
fi
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"
SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-voice-${SUFFIX}"
BRAND_ID="brd_smoke_voice_${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }

say "seed brand + source + package + 5 linkedin_post assets + signals"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO brands(id, slug, name) VALUES ('$BRAND_ID', '$SLUG', 'Smoke Voice $SUFFIX');
INSERT INTO sources(id, brand_id, kind, origin_url)
  VALUES ('src_smoke_voice_$SUFFIX', '$BRAND_ID', 'youtube_url',
          'https://example.com/$SUFFIX');
INSERT INTO packages(id, brand_id, source_id, status)
  VALUES ('pkg_smoke_voice_$SUFFIX', '$BRAND_ID',
          'src_smoke_voice_$SUFFIX', 'analyzed');

INSERT INTO assets(id, package_id, brand_id, type, status, payload)
SELECT 'ast_smoke_voice_' || g || '_$SUFFIX',
       'pkg_smoke_voice_$SUFFIX', '$BRAND_ID', 'linkedin_post', 'approved',
       jsonb_build_object('text', 'Synthetic post number ' || g)
  FROM generate_series(1, 5) g;

-- Assign engagement scores so the top decile is deterministic.
INSERT INTO signals(brand_id, asset_id, source_signal, metric, value, sampled_at)
SELECT '$BRAND_ID',
       'ast_smoke_voice_' || g || '_$SUFFIX',
       'zernio', 'engagement',
       (g * 100)::float,                        -- post 5 wins
       now() - interval '1 hour' * (5 - g)
  FROM generate_series(1, 5) g;
SQL

say "run promote_voice_examples"
pnpm exec tsx -e "
import('./workers/kinds/promote_voice_examples').then(async ({ run }) => {
  await run({
    id: 9999, kind: 'promote_voice_examples',
    payload: { brandId: '$BRAND_ID', assetType: 'linkedin_post', topPercentile: 0.4 },
    status: 'running', priority: 5, attempts: 1, max_attempts: 3,
    locked_by: 'smoke', locked_at: new Date(), run_after: new Date(),
    last_error: null, idempotency_key: null,
    created_at: new Date(), updated_at: new Date(),
  });
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
" 2>&1 | sed 's/^/  /'

INSERTED=$(psql "$DB" -tAc "SELECT count(*) FROM voice_examples WHERE brand_id = '$BRAND_ID'")
echo "  voice_examples rows = $INSERTED"
# 0.4 × 5 = 2 expected rows (the two top-engagement posts).
[[ "$INSERTED" == "2" ]] || die "expected 2 voice_examples (top 40%), got $INSERTED"

TOP_SCORE=$(psql "$DB" -tAc "SELECT round(max(performance_score)::numeric, 2) FROM voice_examples WHERE brand_id = '$BRAND_ID'")
echo "  top performance_score = $TOP_SCORE"
[[ "$TOP_SCORE" == "1.00" ]] || die "expected top score 1.00 after normalization, got $TOP_SCORE"

say "cleanup"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM voice_examples WHERE brand_id = '$BRAND_ID';
DELETE FROM signals WHERE brand_id = '$BRAND_ID';
DELETE FROM assets WHERE brand_id = '$BRAND_ID';
DELETE FROM packages WHERE brand_id = '$BRAND_ID';
DELETE FROM sources WHERE brand_id = '$BRAND_ID';
DELETE FROM brands WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-voice-promotion ok"
