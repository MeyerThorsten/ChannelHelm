#!/usr/bin/env bash
#
# Smoke test for the Session 14 clip_render worker.
#
# Bypasses the LLM pipeline by:
#   1. Running ONLY the ingest worker (yt-dlp + ffmpeg) to put a real
#      original.mp4 on disk and populate sources.local_media_path.
#   2. Hand-rolling a `short_clip_plan` asset with two clip entries.
#   3. PATCHing /api/assets/{plan_id} to status='approved' — the route's
#      approval logic enqueues one clip_render per clip.
#   4. Draining the clip_render queue.
#   5. Asserting the rendered_short_clip assets + .mp4 files landed.
#
# Total runtime is just yt-dlp + ffmpeg work — under 60 seconds even
# without caches.

set -euo pipefail

if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then export "$key=$val"; fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL|MEDIA_ROOT)=' .env)
fi
API="${API_BASE_URL:-http://localhost:3000}"
TOKEN="${LOCAL_BEARER_TOKEN:?LOCAL_BEARER_TOKEN must be set}"
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"
TEST_URL="${TEST_VIDEO_URL:-https://www.youtube.com/watch?v=jNQXAC9IVRw}"

H_AUTH=(-H "Authorization: Bearer $TOKEN")
H_JSON=(-H "Content-Type: application/json")
SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-clip-${SUFFIX}"
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

B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Clip $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
S=$(curl_json POST "$API/api/sources" -d "{\"brandId\":\"$BRAND_ID\",\"kind\":\"youtube_url\",\"originUrl\":\"$TEST_URL\"}")
SOURCE_ID=$(py_get "$S" source.id)
P=$(curl_json POST "$API/api/packages" -d "{\"brandId\":\"$BRAND_ID\",\"sourceId\":\"$SOURCE_ID\"}")
PACKAGE_ID=$(py_get "$P" package.id)
echo "brand=$BRAND_ID source=$SOURCE_ID package=$PACKAGE_ID"

say "run ingest (yt-dlp + ffmpeg only — no LLM)"
pnpm exec tsx workers/runner.ts --kinds ingest --once 2>&1 | sed 's/^/  /'

say "hand-roll a short_clip_plan with 2 clips"
# Two clips over the 19-second test video. Timestamps are deliberate
# integers so the ffmpeg slice math is easy to reason about.
PLAN_ID="ast_smoke_plan_${SUFFIX}"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO assets(id, package_id, brand_id, type, status, payload, provenance)
VALUES (
  '$PLAN_ID', '$PACKAGE_ID', '$BRAND_ID',
  'short_clip_plan', 'ready_for_review',
  jsonb_build_object('clips', jsonb_build_array(
    jsonb_build_object('start', 0,  'end', 8,  'crop', 'center-crop',
                       'title', 'clip A', 'caption', 'first half'),
    jsonb_build_object('start', 8,  'end', 15, 'crop', 'center-crop',
                       'title', 'clip B', 'caption', 'second half')
  )),
  jsonb_build_object('provider', 'smoke', 'model', 'manual', 'generated_at', now()::text)
);
SQL

say "PATCH plan to approved (should enqueue 2 clip_render jobs)"
PATCH=$(curl_json PATCH "$API/api/assets/$PLAN_ID?brandId=$BRAND_ID" -d '{"status":"approved"}')
echo "  $PATCH"
ENQ=$(echo "$PATCH" | python3 -c "import json,sys; print(len(json.loads(sys.stdin.read()).get('enqueued', [])))")
echo "  enqueued = $ENQ"
[[ "$ENQ" == "2" ]] || die "expected 2 enqueued, got $ENQ"

say "drain clip_render queue"
for i in 1 2 3 4 5; do
  PENDING=$(psql "$DB" -tAc "SELECT count(*) FROM jobs WHERE kind='clip_render' AND status='pending' AND payload->>'planAssetId'='$PLAN_ID'")
  if [[ "$PENDING" == "0" ]]; then break; fi
  pnpm exec tsx workers/runner.ts --kinds clip_render --once 2>&1 | sed 's/^/  /'
done

RENDERED=$(psql "$DB" -tAc "SELECT count(*) FROM assets WHERE package_id='$PACKAGE_ID' AND type='rendered_short_clip'")
echo "  rendered_short_clip count = $RENDERED"
[[ "$RENDERED" == "2" ]] || die "expected 2 rendered_short_clip assets, got $RENDERED"

say "verify each rendered MP4 on disk"
LMP=$(psql "$DB" -tAc "SELECT local_media_path FROM sources WHERE id='$SOURCE_ID'")
PATHS=$(psql "$DB" -tAc "SELECT payload->>'local_path' FROM assets WHERE package_id='$PACKAGE_ID' AND type='rendered_short_clip' ORDER BY (payload->>'clip_index')::int")
for p in $PATHS; do
  [[ -s "$p" ]] || die "rendered MP4 missing or empty: $p"
  SIZE=$(wc -c < "$p")
  DUR=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$p" 2>/dev/null | head -1)
  echo "  ✓ $(basename "$p") ($SIZE bytes, ${DUR}s)"
done

# Verify each clip is roughly the requested duration (clip A=8s, clip B=7s)
FIRST_DUR=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$LMP/clips/clip_000.mp4")
SECOND_DUR=$(/opt/homebrew/bin/ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 "$LMP/clips/clip_001.mp4")
python3 -c "
import sys
f, s = float('$FIRST_DUR'), float('$SECOND_DUR')
assert abs(f - 8) < 1.0, f'clip A expected ~8s, got {f}'
assert abs(s - 7) < 1.0, f'clip B expected ~7s, got {s}'
print(f'  ✓ durations within ±1s: clip A={f:.2f}s, clip B={s:.2f}s')
"

say "cleanup"
rm -rf "$LMP"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM assets WHERE brand_id = '$BRAND_ID';
DELETE FROM jobs WHERE payload->>'sourceId' = '$SOURCE_ID'
                    OR payload->>'packageId' = '$PACKAGE_ID'
                    OR payload->>'planAssetId' = '$PLAN_ID';
DELETE FROM packages WHERE brand_id = '$BRAND_ID';
DELETE FROM sources WHERE brand_id = '$BRAND_ID';
DELETE FROM brands WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-clip-render ok"
