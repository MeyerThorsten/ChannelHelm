#!/usr/bin/env bash
#
# Smoke test for the Session 11+12 dispatch worker — verifies the
# "no API key set" rejection path and audit-row recording. No
# external services required.

set -euo pipefail

if [[ -f .env ]]; then
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" == \#* ]] && continue
    if [[ -z "${!key:-}" ]]; then export "$key=$val"; fi
  done < <(grep -E '^(LOCAL_BEARER_TOKEN|DATABASE_URL)=' .env)
fi
DB="${DATABASE_URL:-postgresql://thorstenmeyer@localhost:5432/channelhelm}"
SUFFIX="$(date +%s%N | tail -c 8)"
BRAND_ID="brd_smoke_disp_${SUFFIX}"
ASSET_ID="ast_smoke_disp_${SUFFIX}"

say() { printf '\n→ %s\n' "$*"; }
die() { echo "✗ $*" >&2; exit 1; }

say "seed brand + source + package + approved linkedin_post asset"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
INSERT INTO brands(id, slug, name, zernio_profile_id)
  VALUES ('$BRAND_ID', 'smoke-disp-$SUFFIX', 'Disp $SUFFIX', 'prof_smoke_$SUFFIX');
INSERT INTO sources(id, brand_id, kind) VALUES ('src_disp_$SUFFIX', '$BRAND_ID', 'youtube_url');
INSERT INTO packages(id, brand_id, source_id, status)
  VALUES ('pkg_disp_$SUFFIX', '$BRAND_ID', 'src_disp_$SUFFIX', 'approved');
INSERT INTO assets(id, package_id, brand_id, type, status, payload)
  VALUES ('$ASSET_ID', 'pkg_disp_$SUFFIX', '$BRAND_ID', 'linkedin_post', 'approved',
          jsonb_build_object('text', 'Hello from smoke-dispatch'));
SQL

say "run dispatch worker without ZERNIO_API_KEY (expect failure + audit row)"
# unset to be safe — operator's .env or shell may have one
unset ZERNIO_API_KEY
unset DOJOCLAW_API_KEY
ENQUEUE_OUT=$(pnpm exec tsx -e "
import('./workers/queue').then(async ({ enqueue }) => {
  const r = await enqueue({
    kind: 'dispatch',
    payload: { assetId: '$ASSET_ID' },
    idempotencyKey: 'dispatch:$ASSET_ID',
  });
  console.log(r.id);
  process.exit(0);
}).catch((e) => { console.error(e); process.exit(1); });
" 2>&1)
JOB_ID=$(echo "$ENQUEUE_OUT" | tail -n 1)
echo "  enqueued job id = $JOB_ID"

pnpm exec tsx workers/runner.ts --kinds dispatch --once 2>&1 | sed 's/^/  /'

JOB_STATUS=$(psql "$DB" -tAc "SELECT status FROM jobs WHERE id = $JOB_ID")
JOB_ERR=$(psql "$DB" -tAc "SELECT last_error FROM jobs WHERE id = $JOB_ID")
echo "  job status=$JOB_STATUS"
echo "  job last_error=$JOB_ERR"
[[ "$JOB_STATUS" == "pending" || "$JOB_STATUS" == "failed" ]] \
  || die "expected status=pending|failed (no key), got $JOB_STATUS"
echo "$JOB_ERR" | grep -qi 'ZERNIO_API_KEY' \
  || die "expected last_error to mention ZERNIO_API_KEY, got: $JOB_ERR"

DISPATCH_ROWS=$(psql "$DB" -tAc "SELECT count(*) FROM dispatches WHERE asset_id = '$ASSET_ID'")
echo "  dispatches audit rows = $DISPATCH_ROWS"
[[ "$DISPATCH_ROWS" == "1" ]] || die "expected 1 dispatches row, got $DISPATCH_ROWS"

ASSET_STATUS=$(psql "$DB" -tAc "SELECT status FROM assets WHERE id = '$ASSET_ID'")
echo "  asset status = $ASSET_STATUS"
[[ "$ASSET_STATUS" == "approved" ]] \
  || die "expected asset to stay 'approved' after failed dispatch, got $ASSET_STATUS"

say "cleanup"
psql "$DB" -v ON_ERROR_STOP=1 <<SQL >/dev/null
DELETE FROM dispatches WHERE asset_id = '$ASSET_ID';
DELETE FROM jobs WHERE id = $JOB_ID;
DELETE FROM assets WHERE id = '$ASSET_ID';
DELETE FROM packages WHERE id = 'pkg_disp_$SUFFIX';
DELETE FROM sources WHERE id = 'src_disp_$SUFFIX';
DELETE FROM brands WHERE id = '$BRAND_ID';
SQL
echo "  ✓ cleanup ok"
echo
echo "✓ smoke-dispatch ok"
