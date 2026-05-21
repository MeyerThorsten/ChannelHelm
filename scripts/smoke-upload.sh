#!/usr/bin/env bash
#
# Smoke test for the Session "Content Studio" upload path.
#
#   1. Create a brand via the API.
#   2. Generate a tiny 3s test video (ffmpeg lavfi — blue frame + 440Hz tone).
#   3. Stream it to POST /api/uploads (raw body, no multipart).
#   4. Run the ingest worker --once (uploaded_video branch: no yt-dlp).
#   5. Verify source.local_media_path + audio.wav + duration on disk/DB.
#   6. Cleanup.
#
# Requires a running dev server + ffmpeg.

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
FFMPEG="$(command -v ffmpeg || echo /opt/homebrew/bin/ffmpeg)"

SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-upload-${SUFFIX}"
say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }
py_get() { python3 -c "
import json
d = json.loads('''$1''')
for k in '$2'.split('.'):
    d = d[k]
print(d)
"; }

say "create brand"
B=$(curl -sS -X POST -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d "{\"slug\":\"$SLUG\",\"name\":\"Smoke Upload $SUFFIX\"}" "$API/api/brands")
BRAND_ID=$(py_get "$B" brand.id)
echo "  brand=$BRAND_ID"

say "generate a 3s test video"
TMP=$(mktemp -d)
VIDEO="$TMP/clip.mp4"
"$FFMPEG" -y -f lavfi -i color=c=blue:s=320x240:d=3 \
  -f lavfi -i sine=frequency=440:duration=3 \
  -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac "$VIDEO" 2>/dev/null
echo "  $(ls -lh "$VIDEO" | awk '{print $5}') $VIDEO"

say "POST /api/uploads (raw body stream)"
RESP=$(curl -sS -X POST --data-binary "@$VIDEO" \
  "$API/api/uploads?brandId=$BRAND_ID&filename=clip.mp4&profile=standard_audio_visual")
echo "  $RESP"
SOURCE_ID=$(py_get "$RESP" source.id)
PACKAGE_ID=$(py_get "$RESP" package.id)
echo "  source=$SOURCE_ID package=$PACKAGE_ID"

say "run ingest worker (uploaded_video branch)"
pnpm exec tsx workers/runner.ts --kinds ingest --once 2>&1 | sed 's/^/  /'

# ─── verify ────────────────────────────────────────────────────────────────
ROW=$(psql "$DB" -tAc "SELECT local_media_path, duration_seconds, kind FROM sources WHERE id='$SOURCE_ID'")
echo "  source row: $ROW"
LMP=${ROW%%|*}
DUR=$(echo "$ROW" | awk -F'|' '{print $2}')
KIND=$(echo "$ROW" | awk -F'|' '{print $3}')
[[ "$KIND" == "uploaded_video" ]] || die "expected kind=uploaded_video, got $KIND"
[[ -n "$LMP" ]] || die "local_media_path not set"
(( DUR >= 2 )) || die "duration_seconds < 2 (got $DUR)"
[[ -f "$LMP/original.mp4" ]] || die "original.mp4 missing under $LMP"
[[ -f "$LMP/audio.wav" ]] || die "audio.wav not extracted"
echo "  ✓ uploaded_video ingested: duration=${DUR}s, audio.wav present"

TRANSCRIBE_PENDING=$(psql "$DB" -tAc "SELECT count(*) FROM jobs WHERE kind='transcribe_audio' AND payload->>'sourceId'='$SOURCE_ID'")
[[ "$TRANSCRIBE_PENDING" == "1" ]] || die "expected downstream transcribe_audio enqueued"
echo "  ✓ downstream transcribe_audio enqueued"

# ─── cleanup ───────────────────────────────────────────────────────────────
say "cleanup"
rm -rf "$LMP" "$TMP"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM jobs WHERE payload->>'sourceId' = '$SOURCE_ID';
DELETE FROM packages WHERE id = '$PACKAGE_ID';
DELETE FROM sources WHERE id = '$SOURCE_ID';
DELETE FROM brands WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-upload ok"
