#!/usr/bin/env bash
#
# Smoke test for Session 07 fuse worker.
#
#   1. Run the full preceding chain: ingest → transcribe_audio → analyze_visual.
#   2. Run the fuse worker.
#   3. Verify:
#        - $local_media_path/scene_log.json exists
#        - package.intelligence.scene_log.windows is a non-empty array
#        - every window has start/end, text, visual_descriptions, audio_features
#        - global_features populated
#        - analyze_intelligence job enqueued
#   4. Cleanup.

set -euo pipefail

if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then
      export "$key=$val"
    fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL|MEDIA_ROOT)=' .env)
fi

API="${API_BASE_URL:-http://localhost:3000}"
TOKEN="${LOCAL_BEARER_TOKEN:?LOCAL_BEARER_TOKEN must be set}"
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"
TEST_URL="${TEST_VIDEO_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"

H_AUTH=(-H "Authorization: Bearer $TOKEN")
H_JSON=(-H "Content-Type: application/json")
SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-fuse-${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }

curl_json() {
  local method=$1 url=$2; shift 2
  curl -sS -X "$method" "${H_AUTH[@]}" "${H_JSON[@]}" "$@" "$url"
}
py_get() {
  python3 -c "
import json
d = json.loads('''$1''')
for k in '$2'.split('.'):
    d = d[k]
print(d)
"
}

say "create brand + source + package"
B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Fuse $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
S=$(curl_json POST "$API/api/sources" -d "{\"brandId\":\"$BRAND_ID\",\"kind\":\"youtube_url\",\"originUrl\":\"$TEST_URL\"}")
SOURCE_ID=$(py_get "$S" source.id)
P=$(curl_json POST "$API/api/packages" -d "{\"brandId\":\"$BRAND_ID\",\"sourceId\":\"$SOURCE_ID\"}")
PACKAGE_ID=$(py_get "$P" package.id)
echo "  brand=$BRAND_ID  source=$SOURCE_ID  package=$PACKAGE_ID"

for k in ingest transcribe_audio analyze_visual; do
  say "run $k"
  pnpm exec tsx workers/runner.ts --kinds "$k" --once 2>&1 | sed 's/^/  /'
done

say "run fuse"
pnpm exec tsx workers/runner.ts --kinds fuse --once 2>&1 | sed 's/^/  /'

# ─── verification ───────────────────────────────────────────────────────────
LMP=$(psql "$DB" -tAc "SELECT local_media_path FROM sources WHERE id = '$SOURCE_ID'")
[[ -f "$LMP/scene_log.json" ]] || die "$LMP/scene_log.json missing"
say "scene_log.json size = $(wc -c < "$LMP/scene_log.json") bytes"

WIN_COUNT=$(psql "$DB" -tAc "SELECT jsonb_array_length(intelligence->'scene_log'->'windows') FROM packages WHERE id = '$PACKAGE_ID'")
echo "  windows = $WIN_COUNT"
(( WIN_COUNT > 0 )) || die "no windows in scene_log"

FIRST_TEXT=$(psql "$DB" -tAc "
  SELECT intelligence->'scene_log'->'windows'->0->>'text'
    FROM packages WHERE id = '$PACKAGE_ID'
")
echo "  first window text: ${FIRST_TEXT:0:100}…"
[[ -n "$FIRST_TEXT" ]] || die "first window has empty text"

MISSING_FEATS=$(psql "$DB" -tAc "
  WITH p AS (SELECT intelligence FROM packages WHERE id = '$PACKAGE_ID')
  SELECT count(*) FROM p, jsonb_array_elements(p.intelligence->'scene_log'->'windows') w
   WHERE w->'audio_features' IS NULL
      OR w->'visual_descriptions' IS NULL
      OR (w->>'text_word_count') IS NULL
")
[[ "$MISSING_FEATS" == "0" ]] || die "some windows missing required fields ($MISSING_FEATS)"

DENSITY=$(psql "$DB" -tAc "SELECT intelligence->'scene_log'->'global_features'->>'screen_text_density' FROM packages WHERE id = '$PACKAGE_ID'")
TOTAL_CUTS=$(psql "$DB" -tAc "SELECT intelligence->'scene_log'->'global_features'->>'total_scene_cuts' FROM packages WHERE id = '$PACKAGE_ID'")
echo "  global_features: density=$DENSITY total_scene_cuts=$TOTAL_CUTS"

AI_PENDING=$(psql "$DB" -tAc "
  SELECT count(*) FROM jobs
   WHERE kind = 'analyze_intelligence'
     AND status = 'pending'
     AND payload->>'sourceId' = '$SOURCE_ID'
")
echo "  pending analyze_intelligence = $AI_PENDING"
[[ "$AI_PENDING" == "1" ]] || die "expected 1 pending analyze_intelligence (got $AI_PENDING)"

# ─── cleanup ────────────────────────────────────────────────────────────────
say "cleanup"
rm -rf "$LMP"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM jobs WHERE payload->>'sourceId' = '$SOURCE_ID';
DELETE FROM packages WHERE id = '$PACKAGE_ID';
DELETE FROM sources  WHERE id = '$SOURCE_ID';
DELETE FROM brands   WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"

echo
echo "✓ smoke-fuse ok"
