#!/usr/bin/env bash
#
# Smoke test for the Session 02 API. Exercises:
#   GET  /api/brands?active=true
#   POST /api/brands
#   GET  /api/brands/[id]
#   PATCH /api/brands/[id]
#   POST /api/sources
#   GET  /api/sources?brand_id=...
#   POST /api/packages
#   GET  /api/packages?brand_id=...
#   PATCH /api/packages/[id]   (status: draft -> analyzing)
#   401 path  (missing/wrong bearer)
#
# Requires a running dev server. Cleans up via psql at the end so the DB is
# empty when the script finishes.
#
# Env:
#   LOCAL_BEARER_TOKEN  - bearer token (also read from .env if not set)
#   API_BASE_URL        - default http://localhost:3000
#   DATABASE_URL        - psql connection string for cleanup
#                         (default postgresql://thorstenmeyer@localhost:5432/channelhelm)

set -euo pipefail

# Per-variable .env loading: only fill in what wasn't exported by the caller.
if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then
      export "$key=$val"
    fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL)=' .env)
fi

API="${API_BASE_URL:-http://localhost:3000}"
TOKEN="${LOCAL_BEARER_TOKEN:?LOCAL_BEARER_TOKEN must be set}"
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"

H_AUTH=(-H "Authorization: Bearer $TOKEN")
H_JSON=(-H "Content-Type: application/json")
SUFFIX="$(date +%s%N | tail -c 8)"
SLUG="smoke-${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }

curl_json() {
  local method=$1 url=$2
  shift 2
  curl -sS -w '\n%{http_code}\n' -X "$method" "${H_AUTH[@]}" "${H_JSON[@]}" "$@" "$url"
}

assert_code() {
  local got=$1 want=$2 label=$3
  if [[ "$got" != "$want" ]]; then
    echo "✗ $label: expected $want, got $got" >&2
    exit 1
  fi
  echo "  ✓ $label ($got)"
}

extract_id() {
  local json=$1 key=$2
  # parse first "id":"..." inside the nested object value
  python3 -c "
import json, sys
d = json.loads('''$json''')
print(d['$key']['id'])
"
}

# ─── 401 path ───────────────────────────────────────────────────────────────
say "401 without bearer"
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' "$API/api/brands?active=true" || true)
assert_code "$HTTP" "401" "GET /api/brands unauthenticated"

say "401 with wrong bearer"
HTTP=$(curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer wrong" "$API/api/brands?active=true" || true)
assert_code "$HTTP" "401" "GET /api/brands wrong-bearer"

# ─── brands ─────────────────────────────────────────────────────────────────
say "POST /api/brands ($SLUG)"
RESP=$(curl_json POST "$API/api/brands" -d "{
  \"slug\": \"$SLUG\",
  \"name\": \"Smoke Brand $SUFFIX\",
  \"defaultProcessingProfile\": \"standard_audio_visual\"
}")
CODE=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_code "$CODE" "201" "create brand"
BRAND_ID=$(extract_id "$BODY" brand)
echo "  brand_id = $BRAND_ID"

say "GET /api/brands/$BRAND_ID"
RESP=$(curl_json GET "$API/api/brands/$BRAND_ID")
assert_code "$(echo "$RESP" | tail -n1)" "200" "get brand"

say "PATCH /api/brands/$BRAND_ID (rename)"
RESP=$(curl_json PATCH "$API/api/brands/$BRAND_ID" -d '{"name": "Smoke Brand (renamed)"}')
assert_code "$(echo "$RESP" | tail -n1)" "200" "patch brand"

say "GET /api/brands?active=true"
RESP=$(curl_json GET "$API/api/brands?active=true")
assert_code "$(echo "$RESP" | tail -n1)" "200" "list active brands"

# ─── sources ────────────────────────────────────────────────────────────────
say "POST /api/sources"
RESP=$(curl_json POST "$API/api/sources" -d "{
  \"brandId\": \"$BRAND_ID\",
  \"kind\": \"youtube_url\",
  \"originUrl\": \"https://www.youtube.com/watch?v=smoke\"
}")
CODE=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_code "$CODE" "201" "create source"
SOURCE_ID=$(extract_id "$BODY" source)
echo "  source_id = $SOURCE_ID"

say "GET /api/sources?brand_id=$BRAND_ID"
RESP=$(curl_json GET "$API/api/sources?brand_id=$BRAND_ID")
assert_code "$(echo "$RESP" | tail -n1)" "200" "list sources for brand"

# ─── packages ───────────────────────────────────────────────────────────────
say "POST /api/packages"
RESP=$(curl_json POST "$API/api/packages" -d "{
  \"brandId\": \"$BRAND_ID\",
  \"sourceId\": \"$SOURCE_ID\"
}")
CODE=$(echo "$RESP" | tail -n1); BODY=$(echo "$RESP" | sed '$d')
assert_code "$CODE" "201" "create package"
PACKAGE_ID=$(extract_id "$BODY" package)
echo "  package_id = $PACKAGE_ID"

say "PATCH /api/packages/$PACKAGE_ID (status: draft -> analyzing)"
RESP=$(curl_json PATCH "$API/api/packages/$PACKAGE_ID" -d '{"status": "analyzing"}')
assert_code "$(echo "$RESP" | tail -n1)" "200" "patch package status"

say "GET /api/packages?brand_id=$BRAND_ID&status=analyzing"
RESP=$(curl_json GET "$API/api/packages?brand_id=$BRAND_ID&status=analyzing")
assert_code "$(echo "$RESP" | tail -n1)" "200" "list packages by status"

# ─── validation ─────────────────────────────────────────────────────────────
say "POST /api/brands (missing required fields)"
RESP=$(curl_json POST "$API/api/brands" -d '{}')
assert_code "$(echo "$RESP" | tail -n1)" "400" "rejects empty brand body"

# ─── cleanup ────────────────────────────────────────────────────────────────
say "cleanup via psql"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM packages WHERE id = '$PACKAGE_ID';
DELETE FROM sources  WHERE id = '$SOURCE_ID';
DELETE FROM brands   WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"

echo
echo "✓ smoke-api ok"
