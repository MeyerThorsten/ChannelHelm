#!/usr/bin/env bash
#
# Smoke test for the Session 06 analyze_visual worker.
#
#   1. Run the Session 04 chain (brand → source → package → ingest) with the
#      default standard_audio_visual profile, which enqueues both
#      transcribe_audio and analyze_visual.
#   2. Run the analyze_visual worker. This samples frames at 1 fps via
#      ffmpeg, runs Apple Vision OCR over them, runs mlx-vlm Qwen2.5-VL 7B
#      4-bit over them, and merges into intelligence.frame_index.
#   3. Verify:
#        - $local_media_path/frames/frame_NNNNNN.jpg files exist (≥ 1)
#        - $local_media_path/frame_index.json exists
#        - package.intelligence.frame_index.frame_count > 0
#        - every frame has a non-empty description
#        - provenance.vlm.provider == 'mlx-vlm'
#        - provenance.ocr.provider == 'apple-vision'
#   4. Cleanup.
#
# First run downloads the VLM weights (~5 GB for 7B 4-bit). Subsequent runs
# are bound by VLM inference time (~5-15 s per frame on Apple Silicon).

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
SLUG="smoke-visual-${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }

curl_json() {
  local method=$1 url=$2; shift 2
  curl -sS -X "$method" "${H_AUTH[@]}" "${H_JSON[@]}" "$@" "$url"
}

py_get() {
  python3 -c "
import json, sys
d = json.loads('''$1''')
for k in '$2'.split('.'):
    d = d[k]
print(d)
"
}

say "create brand + source + package (profile=standard_audio_visual)"
B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Visual $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
S=$(curl_json POST "$API/api/sources" -d "{\"brandId\":\"$BRAND_ID\",\"kind\":\"youtube_url\",\"originUrl\":\"$TEST_URL\"}")
SOURCE_ID=$(py_get "$S" source.id)
P=$(curl_json POST "$API/api/packages" -d "{\"brandId\":\"$BRAND_ID\",\"sourceId\":\"$SOURCE_ID\"}")
PACKAGE_ID=$(py_get "$P" package.id)
echo "  brand=$BRAND_ID  source=$SOURCE_ID  package=$PACKAGE_ID"

say "run ingest worker"
pnpm exec tsx workers/runner.ts --kinds ingest --once 2>&1 | sed 's/^/  /'

say "run analyze_visual worker (first run downloads ~5 GB Qwen2.5-VL 7B 4-bit)"
pnpm exec tsx workers/runner.ts --kinds analyze_visual --once 2>&1 | sed 's/^/  /'

# ─── verification ───────────────────────────────────────────────────────────
LMP=$(psql "$DB" -tAc "SELECT local_media_path FROM sources WHERE id = '$SOURCE_ID'")
say "verify frames on disk under $LMP"
FRAME_COUNT=$(ls "$LMP/frames"/frame_*.jpg 2>/dev/null | wc -l | tr -d ' ')
echo "  frame_*.jpg count = $FRAME_COUNT"
(( FRAME_COUNT > 0 )) || die "no frames sampled"
[[ -f "$LMP/frame_index.json" ]] || die "frame_index.json missing"

say "verify DB state"
DB_FRAME_COUNT=$(psql "$DB" -tAc "SELECT (intelligence->'frame_index'->>'frame_count')::int FROM packages WHERE id = '$PACKAGE_ID'")
echo "  intelligence.frame_index.frame_count = $DB_FRAME_COUNT"
(( DB_FRAME_COUNT == FRAME_COUNT )) || die "DB frame_count ($DB_FRAME_COUNT) != on-disk frame count ($FRAME_COUNT)"

EMPTY_DESCRIPTIONS=$(psql "$DB" -tAc "
  SELECT count(*) FROM jsonb_array_elements(intelligence->'frame_index'->'frames') AS f
   WHERE coalesce(f->>'description','') = ''
  FROM packages WHERE id = '$PACKAGE_ID'
" 2>/dev/null || echo "")
# Re-query in a cleaner form because the above SELECT-FROM combo is awkward.
EMPTY_DESCRIPTIONS=$(psql "$DB" -tAc "
  WITH p AS (SELECT intelligence FROM packages WHERE id = '$PACKAGE_ID')
  SELECT count(*) FROM p, jsonb_array_elements(p.intelligence->'frame_index'->'frames') AS f
   WHERE coalesce(f->>'description','') = ''
")
echo "  frames with empty description = $EMPTY_DESCRIPTIONS"
[[ "$EMPTY_DESCRIPTIONS" == "0" ]] || die "expected every frame to have a description"

OCR_PROVIDER=$(psql "$DB" -tAc "SELECT intelligence->'frame_index'->'provenance'->'ocr'->>'provider' FROM packages WHERE id = '$PACKAGE_ID'")
VLM_PROVIDER=$(psql "$DB" -tAc "SELECT intelligence->'frame_index'->'provenance'->'vlm'->>'provider' FROM packages WHERE id = '$PACKAGE_ID'")
echo "  provenance.ocr.provider = $OCR_PROVIDER"
echo "  provenance.vlm.provider = $VLM_PROVIDER"
[[ "$OCR_PROVIDER" == "apple-vision" ]] || die "expected ocr provenance.provider=apple-vision"
[[ "$VLM_PROVIDER" == "mlx-vlm" ]] || die "expected vlm provenance.provider=mlx-vlm"

# ─── preview ────────────────────────────────────────────────────────────────
say "first frame description preview:"
psql "$DB" -tAc "
  WITH p AS (SELECT intelligence->'frame_index'->'frames'->0 AS first_frame
               FROM packages WHERE id = '$PACKAGE_ID')
  SELECT 'description: ' || coalesce(first_frame->>'description', '(empty)') FROM p
  UNION ALL
  SELECT 'on_screen_text: ' || coalesce(first_frame->>'on_screen_text_joined', '(none)') FROM p
" | sed 's/^/  /'

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
echo "✓ smoke-analyze-visual ok"
