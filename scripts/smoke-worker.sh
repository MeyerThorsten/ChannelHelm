#!/usr/bin/env bash
#
# Smoke test for the Session 03 worker daemon.
#
#   1. Enqueue a `noop` job via POST /api/jobs (covers the §13.3 acceptance:
#      "Enqueue a noop job via the API").
#   2. Run `pnpm worker -- --kinds noop --once` to claim → run → complete it.
#   3. Verify the row's status flipped to 'done'.
#   4. Enqueue a job with payload.fail=true, run runner with max_attempts=1
#      against it, verify it ends at status='failed' with last_error set.
#   5. psql cleanup.
#
# Requires a running dev server (Session 02). Same env loading as smoke-api.sh.

set -euo pipefail

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

say() { printf '\n→ %s\n' "$*"; }

extract_id() {
  python3 -c "
import json, sys
print(json.loads('''$1''')['job']['id'])
"
}

q_status() {
  psql "$DB" -tAc "SELECT status, attempts, COALESCE(last_error,'') FROM jobs WHERE id = $1"
}

# ─── happy-path: enqueue + claim + complete ────────────────────────────────
say "POST /api/jobs (kind=noop)"
BODY=$(curl -sS -X POST "${H_AUTH[@]}" "${H_JSON[@]}" \
  -d "{\"kind\":\"noop\",\"payload\":{\"smoke\":\"$SUFFIX\"},\"idempotencyKey\":\"smoke:noop:$SUFFIX\"}" \
  "$API/api/jobs")
echo "  $BODY"
JOB_ID=$(extract_id "$BODY")
echo "  job_id = $JOB_ID"

say "verify enqueue is idempotent (same key → created:false)"
BODY2=$(curl -sS -X POST "${H_AUTH[@]}" "${H_JSON[@]}" \
  -d "{\"kind\":\"noop\",\"payload\":{\"ignored\":true},\"idempotencyKey\":\"smoke:noop:$SUFFIX\"}" \
  "$API/api/jobs")
echo "  $BODY2"
if ! echo "$BODY2" | grep -q '"created":false'; then
  echo "✗ expected created:false on second enqueue with same idempotency key" >&2
  exit 1
fi
echo "  ✓ idempotency honoured"

say "run worker --once --kinds noop"
pnpm exec tsx workers/runner.ts --kinds noop --once 2>&1 | sed 's/^/  /'

STATE=$(q_status "$JOB_ID")
echo "  state: $STATE"
if [[ ! "$STATE" =~ ^done\| ]]; then
  echo "✗ expected status=done, got: $STATE" >&2
  exit 1
fi
echo "  ✓ happy path done"

# ─── failure path: payload.fail=true ────────────────────────────────────────
say "POST /api/jobs (forced fail, max_attempts=1)"
BODY=$(curl -sS -X POST "${H_AUTH[@]}" "${H_JSON[@]}" \
  -d "{\"kind\":\"noop\",\"payload\":{\"fail\":true,\"error\":\"smoke-fail-$SUFFIX\"},\"idempotencyKey\":\"smoke:fail:$SUFFIX\"}" \
  "$API/api/jobs")
FAIL_JOB_ID=$(extract_id "$BODY")
echo "  fail_job_id = $FAIL_JOB_ID"

# Force max_attempts=1 so the failure is terminal after a single try.
psql "$DB" -v ON_ERROR_STOP=1 -c "UPDATE jobs SET max_attempts = 1 WHERE id = $FAIL_JOB_ID" >/dev/null

say "run worker --once on failure job"
pnpm exec tsx workers/runner.ts --kinds noop --once 2>&1 | sed 's/^/  /'

STATE=$(q_status "$FAIL_JOB_ID")
echo "  state: $STATE"
if [[ ! "$STATE" =~ ^failed\|.*smoke-fail- ]]; then
  echo "✗ expected status=failed with last_error set, got: $STATE" >&2
  exit 1
fi
echo "  ✓ failure path recorded with last_error"

# ─── cleanup ────────────────────────────────────────────────────────────────
say "cleanup via psql"
psql "$DB" -v ON_ERROR_STOP=1 -c "DELETE FROM jobs WHERE id IN ($JOB_ID, $FAIL_JOB_ID)" >/dev/null
echo "  ✓ cleanup ok"

echo
echo "✓ smoke-worker ok"
