#!/usr/bin/env bash
#
# Publish the marketing site (public/*.html) to channelhelm.com on all-inkl
# over FTP(S) with curl. Repeatable: `pnpm deploy:marketing`.
#
# Credentials come from .deploy.env (gitignored — copy .deploy.env.example).
# Never hard-code or commit them.
#
# Flags:
#   --dry-run        list what would upload, transfer nothing
#   --prune-legacy   also delete known-orphaned files on the server (legal.css)
#
set -euo pipefail
cd "$(dirname "$0")/.."

DRY_RUN=0
PRUNE_LEGACY=0
for a in "$@"; do
  case "$a" in
    --dry-run) DRY_RUN=1 ;;
    --prune-legacy) PRUNE_LEGACY=1 ;;
    *) echo "unknown flag: $a" >&2; exit 2 ;;
  esac
done

[ -f .deploy.env ] || { echo "✗ missing .deploy.env (copy .deploy.env.example and fill it in)" >&2; exit 1; }
set -a; . ./.deploy.env; set +a
: "${FTP_HOST:?set FTP_HOST in .deploy.env}"
: "${FTP_USER:?set FTP_USER in .deploy.env}"
: "${FTP_PASS:?set FTP_PASS in .deploy.env}"
FTP_PATH="${FTP_PATH:-/}"
case "$FTP_PATH" in */) ;; *) FTP_PATH="$FTP_PATH/" ;; esac

# TLS on the CONTROL channel only (login/password encrypted), data channel in
# clear. all-inkl's ProFTPD rejects TLS-session reuse on the *data* channel —
# full FTPS (--ssl-reqd) aborts every transfer after the first with a 426. The
# uploaded files are the PUBLIC marketing site, so clear-text data is fine; the
# password stays protected by control-channel TLS. --disable-epsv forces classic
# PASV (all-inkl's EPSV is flaky). All files go in ONE session to avoid the
# server's rapid-login throttle.
CURL_BASE=(curl -fsS --ftp-ssl-control --disable-epsv --retry 2 --retry-delay 2
  --connect-timeout 20 --user "$FTP_USER:$FTP_PASS")
BASE_URL="ftp://${FTP_HOST}${FTP_PATH}"

shopt -s nullglob
files=(public/*.html)
[ "${#files[@]}" -gt 0 ] || { echo "✗ no public/*.html to deploy" >&2; exit 1; }

echo "→ ${#files[@]} pages → ${FTP_HOST}${FTP_PATH} (FTPS)"
if [ "$DRY_RUN" = 1 ]; then
  for f in "${files[@]}"; do echo "  [dry-run] $(basename "$f")"; done
  exit 0
fi

# Upload every file in ONE curl session (reuses the control connection;
# avoids the rapid-login throttle that 426s separate per-file logins).
upload_args=()
for f in "${files[@]}"; do
  upload_args+=(-T "$f" "${BASE_URL}$(basename "$f")")
done
"${CURL_BASE[@]}" "${upload_args[@]}"
for f in "${files[@]}"; do echo "  ✓ $(basename "$f")"; done
ok=${#files[@]}

if [ "$PRUNE_LEGACY" = 1 ]; then
  # legal.css was inlined into the legal pages and removed from the repo;
  # delete it from the server if present. Ignore "not found".
  if "${CURL_BASE[@]}" -Q "DELE ${FTP_PATH}legal.css" "ftp://${FTP_HOST}/" >/dev/null 2>&1; then
    echo "  ✓ pruned legacy legal.css"
  else
    echo "  · legal.css not present (nothing to prune)"
  fi
fi

echo "✓ deployed ${ok} page(s) to channelhelm.com"
