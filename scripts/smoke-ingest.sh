#!/usr/bin/env bash
#
# Smoke test for the Session 04 ingest worker.
#
#   1. Create a brand + source (YouTube URL) + package via the API. Creating
#      the package auto-enqueues an `ingest` job (idempotency key per §4).
#   2. Run `pnpm worker --kinds ingest --once` to claim and process it.
#   3. Verify:
#        - source.local_media_path is set
#        - source.duration_seconds > 0
#        - $MEDIA_ROOT/$slug/$source_id/original.mp4 exists
#        - $MEDIA_ROOT/$slug/$source_id/audio.wav exists
#        - package.intelligence.scene_cuts is an array
#        - one transcribe_audio job is now pending for this source
#   4. Clean up: media directory, downstream queued jobs, rows.
#
# Env overrides:
#   TEST_VIDEO_URL — defaults to https://www.youtube.com/watch?v=jNQXAC9IVRw
#                    ("Me at the zoo", 18s — the first video ever uploaded to
#                     YouTube, intentionally tiny and ancient so it's stable).
#   MEDIA_ROOT     — defaults to ./media (also read from .env)

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
SLUG="smoke-ingest-${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }

curl_json() {
  local method=$1 url=$2; shift 2
  curl -sS -X "$method" "${H_AUTH[@]}" "${H_JSON[@]}" "$@" "$url"
}

py_get() {
  local json=$1 path=$2
  python3 -c "
import json, sys
d = json.loads('''$json''')
for k in '$path'.split('.'):
    d = d[k]
print(d)
"
}

say "POST /api/brands (slug=$SLUG)"
B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Ingest $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
echo "  brand_id = $BRAND_ID"

say "POST /api/sources (kind=youtube_url)"
S=$(curl_json POST "$API/api/sources" -d "{
  \"brandId\": \"$BRAND_ID\",
  \"kind\": \"youtube_url\",
  \"originUrl\": \"$TEST_URL\"
}")
SOURCE_ID=$(py_get "$S" source.id)
echo "  source_id = $SOURCE_ID"

say "POST /api/packages (auto-enqueues ingest)"
P=$(curl_json POST "$API/api/packages" -d "{
  \"brandId\": \"$BRAND_ID\",
  \"sourceId\": \"$SOURCE_ID\"
}")
PACKAGE_ID=$(py_get "$P" package.id)
INGEST_JOB_ID=$(py_get "$P" ingestJob.id)
echo "  package_id = $PACKAGE_ID"
echo "  ingest_job_id = $INGEST_JOB_ID"

say "run worker --kinds ingest --once  (this hits the network; ~20s)"
pnpm exec tsx workers/runner.ts --kinds ingest --once 2>&1 | sed 's/^/  /'

# ─── verification ───────────────────────────────────────────────────────────
say "verify DB state"
ROW=$(psql "$DB" -tAc "SELECT local_media_path, duration_seconds FROM sources WHERE id = '$SOURCE_ID'")
LMP=${ROW%|*}; DUR=${ROW##*|}
echo "  local_media_path = $LMP"
echo "  duration_seconds = $DUR"
[[ -n "$LMP" ]] || die "local_media_path not set"
(( DUR > 0 )) || die "duration_seconds not > 0 (got: $DUR)"

JOB_STATE=$(psql "$DB" -tAc "SELECT status FROM jobs WHERE id = $INGEST_JOB_ID")
echo "  ingest job status = $JOB_STATE"
[[ "$JOB_STATE" == "done" ]] || die "ingest job did not reach status=done (got: $JOB_STATE)"

DOWNSTREAM=$(psql "$DB" -tAc "SELECT count(*) FROM jobs WHERE kind = 'transcribe_audio' AND status = 'pending' AND payload->>'sourceId' = '$SOURCE_ID'")
echo "  pending transcribe_audio jobs for this source = $DOWNSTREAM"
[[ "$DOWNSTREAM" == "1" ]] || die "expected exactly 1 pending transcribe_audio job"

SCENE_CUTS_TYPE=$(psql "$DB" -tAc "SELECT jsonb_typeof(intelligence->'scene_cuts') FROM packages WHERE id = '$PACKAGE_ID'")
echo "  intelligence.scene_cuts type = $SCENE_CUTS_TYPE"
[[ "$SCENE_CUTS_TYPE" == "array" ]] || die "intelligence.scene_cuts is not a JSON array (got: $SCENE_CUTS_TYPE)"

# ─── file verification ─────────────────────────────────────────────────────
say "verify on-disk media"
[[ -f "$LMP/original.mp4" ]] || die "$LMP/original.mp4 missing"
[[ -f "$LMP/audio.wav" ]] || die "$LMP/audio.wav missing"
[[ -f "$LMP/original.info.json" ]] || die "$LMP/original.info.json missing"
ls -lah "$LMP" | sed 's/^/  /'

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
echo "✓ smoke-ingest ok"
