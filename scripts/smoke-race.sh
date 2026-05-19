#!/usr/bin/env bash
#
# Chaos-style smoke for the §5 race fix.
#
# Goal: prove that running transcribe_audio and analyze_visual
# concurrently (the realistic production setup — different Macs claiming
# different kinds) does NOT lose either's intelligence merge.
#
# Approach:
#   1. Run ingest to produce audio.wav + frames-ready original.mp4.
#   2. Spawn `--once` runners for transcribe_audio and analyze_visual
#      in parallel via `&`; wait for both.
#   3. Assert packages.intelligence has BOTH `transcript` and
#      `frame_index` keys, each with their provenance block intact.
#
# Without the jsonb || jsonb fix (commit 487bb3f), the second writer's
# read-modify-write would clobber the first's key roughly half the
# time. With the fix, this is deterministic.

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
SLUG="smoke-race-${SUFFIX}"
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

B=$(curl_json POST "$API/api/brands" -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Race $SUFFIX\"}")
BRAND_ID=$(py_get "$B" brand.id)
S=$(curl_json POST "$API/api/sources" -d "{\"brandId\":\"$BRAND_ID\",\"kind\":\"youtube_url\",\"originUrl\":\"$TEST_URL\"}")
SOURCE_ID=$(py_get "$S" source.id)
P=$(curl_json POST "$API/api/packages" -d "{\"brandId\":\"$BRAND_ID\",\"sourceId\":\"$SOURCE_ID\"}")
PACKAGE_ID=$(py_get "$P" package.id)
echo "brand=$BRAND_ID source=$SOURCE_ID package=$PACKAGE_ID"

say "run ingest"
pnpm exec tsx workers/runner.ts --kinds ingest --once 2>&1 | sed 's/^/  /'

say "spawn transcribe_audio + analyze_visual in parallel"
# Both run --once with separate log files. The kernel will interleave
# their UPDATE jobs SQL calls; with the atomic jsonb || jsonb fix neither
# clobbers the other's top-level key.
LOG_T=$(mktemp)
LOG_V=$(mktemp)
pnpm exec tsx workers/runner.ts --kinds transcribe_audio --once >"$LOG_T" 2>&1 &
PID_T=$!
pnpm exec tsx workers/runner.ts --kinds analyze_visual --once >"$LOG_V" 2>&1 &
PID_V=$!
wait $PID_T
wait $PID_V
echo "  transcribe done: $(grep -E '(done|fail)' "$LOG_T" | tail -1)"
echo "  visual    done: $(grep -E '(done|fail)' "$LOG_V" | tail -1)"

# ─── verify both keys survived the race ────────────────────────────────────
say "verify packages.intelligence has BOTH transcript and frame_index"
HAS_T=$(psql "$DB" -tAc "SELECT intelligence ? 'transcript' FROM packages WHERE id = '$PACKAGE_ID'")
HAS_V=$(psql "$DB" -tAc "SELECT intelligence ? 'frame_index' FROM packages WHERE id = '$PACKAGE_ID'")
echo "  has transcript  = $HAS_T"
echo "  has frame_index = $HAS_V"
[[ "$HAS_T" == "t" ]] || die "transcript key missing — race lost the transcribe_audio write"
[[ "$HAS_V" == "t" ]] || die "frame_index key missing — race lost the analyze_visual write"

T_PROV=$(psql "$DB" -tAc "SELECT intelligence->'transcript'->'provenance'->>'provider' FROM packages WHERE id = '$PACKAGE_ID'")
V_PROV=$(psql "$DB" -tAc "SELECT intelligence->'frame_index'->'provenance'->'vlm'->>'provider' FROM packages WHERE id = '$PACKAGE_ID'")
echo "  transcript.provenance.provider  = $T_PROV"
echo "  frame_index.provenance.vlm.provider = $V_PROV"
[[ "$T_PROV" == "mlx-whisper" ]] || die "transcript provenance lost"
[[ "$V_PROV" == "mlx-vlm" ]] || die "frame_index provenance lost"

# Also: per §6.2, the second sibling to finish should have enqueued fuse.
FUSE=$(psql "$DB" -tAc "SELECT count(*) FROM jobs WHERE kind='fuse' AND payload->>'sourceId' = '$SOURCE_ID'")
echo "  fuse jobs for source = $FUSE"
[[ "$FUSE" == "1" ]] || die "expected exactly 1 fuse job after both siblings finished (got $FUSE)"

# ─── cleanup ───────────────────────────────────────────────────────────────
LMP=$(psql "$DB" -tAc "SELECT local_media_path FROM sources WHERE id='$SOURCE_ID'")
say "cleanup"
rm -rf "$LMP" "$LOG_T" "$LOG_V"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM assets WHERE brand_id = '$BRAND_ID';
DELETE FROM jobs WHERE payload->>'sourceId' = '$SOURCE_ID' OR payload->>'packageId' = '$PACKAGE_ID';
DELETE FROM packages WHERE brand_id = '$BRAND_ID';
DELETE FROM sources WHERE brand_id = '$BRAND_ID';
DELETE FROM brands WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-race ok"
