#!/usr/bin/env bash
#
# Smoke test for the Session 05 transcribe_audio worker.
#
#   1. Run the Session 04 chain (brand → source → package → ingest) so an
#      audio.wav exists.
#   2. Claim the auto-enqueued transcribe_audio job and run `ml/transcribe.py`
#      via the worker.
#   3. Verify:
#        - $local_media_path/transcript.json exists
#        - package.intelligence.transcript.text is non-empty
#        - package.intelligence.transcript.provenance.provider = mlx-whisper
#        - one fuse job is pending for this source (the §6.2 "sibling done →
#          enqueue fuse" path, since analyze_visual hasn't been registered
#          yet so its sibling lookup returns empty → enqueue fires).
#   4. Cleanup: media dir, all queued jobs for this source, rows.
#
# First run downloads ~3 GB of MLX Whisper large-v3 weights from HuggingFace
# (~1-2 min on a fast connection). Subsequent runs are ~10-20s on Apple
# Silicon.
#
# Requires `cd ml && uv sync` to have completed at least once.

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
MEDIA_ROOT="${MEDIA_ROOT:-./media}"
TEST_URL="${TEST_VIDEO_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"

H_AUTH=(-H "Authorization: Bearer $TOKEN")
H_JSON=(-H "Content-Type: application/json")
SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-transcribe-${SUFFIX}"

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

say "create brand + source + package (also enqueues ingest)"
B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Transcribe $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
S=$(curl_json POST "$API/api/sources" -d "{\"brandId\":\"$BRAND_ID\",\"kind\":\"youtube_url\",\"originUrl\":\"$TEST_URL\"}")
SOURCE_ID=$(py_get "$S" source.id)
# Use fast_audio_only so no analyze_visual job is enqueued and the sibling
# check in transcribe_audio falls through to enqueue fuse — Session 06 will
# add the analyze_visual handler.
P=$(curl_json POST "$API/api/packages" -d "{
  \"brandId\":\"$BRAND_ID\",
  \"sourceId\":\"$SOURCE_ID\",
  \"processingProfile\":\"fast_audio_only\"
}")
PACKAGE_ID=$(py_get "$P" package.id)
echo "  brand=$BRAND_ID  source=$SOURCE_ID  package=$PACKAGE_ID  profile=fast_audio_only"

say "run ingest worker"
pnpm exec tsx workers/runner.ts --kinds ingest --once 2>&1 | sed 's/^/  /'

say "run transcribe_audio worker (first run downloads ~3 GB)"
pnpm exec tsx workers/runner.ts --kinds transcribe_audio --once 2>&1 | sed 's/^/  /'

# ─── verification ───────────────────────────────────────────────────────────
LMP=$(psql "$DB" -tAc "SELECT local_media_path FROM sources WHERE id = '$SOURCE_ID'")
say "verify transcript on disk: $LMP/transcript.json"
[[ -f "$LMP/transcript.json" ]] || die "$LMP/transcript.json missing"
TRANSCRIPT_LEN=$(wc -c < "$LMP/transcript.json")
echo "  transcript.json size = $TRANSCRIPT_LEN bytes"
(( TRANSCRIPT_LEN > 100 )) || die "transcript.json suspiciously small"

say "verify DB state"
TEXT=$(psql "$DB" -tAc "SELECT length(intelligence->'transcript'->>'text') FROM packages WHERE id = '$PACKAGE_ID'")
echo "  transcript.text length in DB = $TEXT"
(( TEXT > 20 )) || die "transcript.text shorter than expected (got: $TEXT)"

PROVIDER=$(psql "$DB" -tAc "SELECT intelligence->'transcript'->'provenance'->>'provider' FROM packages WHERE id = '$PACKAGE_ID'")
echo "  provenance.provider = $PROVIDER"
[[ "$PROVIDER" == "mlx-whisper" ]] || die "expected provenance.provider=mlx-whisper, got: $PROVIDER"

FUSE_PENDING=$(psql "$DB" -tAc "SELECT count(*) FROM jobs WHERE kind = 'fuse' AND status = 'pending' AND payload->>'sourceId' = '$SOURCE_ID'")
echo "  pending fuse jobs for source = $FUSE_PENDING"
[[ "$FUSE_PENDING" == "1" ]] || die "expected exactly 1 pending fuse job (got $FUSE_PENDING)"

# ─── content-spot-check ─────────────────────────────────────────────────────
say "transcript preview (first 200 chars):"
psql "$DB" -tAc "SELECT substring(intelligence->'transcript'->>'text', 1, 200) FROM packages WHERE id = '$PACKAGE_ID'" | sed 's/^/  /'

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
echo "✓ smoke-transcribe ok"
