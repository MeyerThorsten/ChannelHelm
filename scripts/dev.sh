#!/usr/bin/env bash
#
# Dev convenience: run the Next.js web server AND the worker daemon together
# so generation auto-starts when you add a video. Ctrl-C stops both.
#
# In production these are separate launchd services (infra/launchd/*); this
# script is only for single-Mac local dev.
#
# Env:
#   PORT               web server port (default 3000). Override per-machine in
#                      .env (e.g. PORT=3002 when 3000 is taken by another app).
#   DATABASE_URL       inherited; falls back to .env

set -euo pipefail

# Load per-machine overrides from .env (PORT, DATABASE_URL, …) so a local
# PORT=3002 in .env takes effect without editing this script. An explicit
# shell `PORT=… pnpm dev:all` still wins; the conventional default is 3000.
_shell_port="${PORT:-}"
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env 2>/dev/null || true
  set +a
fi
PORT="${_shell_port:-${PORT:-3000}}"
WORKER_KINDS="${WORKER_KINDS:-ingest,transcribe_audio,analyze_visual,fuse,analyze_intelligence,generate_asset,thumbnail_concepts,clip_render,dispatch,collect_signal,promote_voice_examples}"
# How many concurrent claim slots the worker process holds. 3 is a good
# default for a single-creator LLM-bound workload; bump if you hit "lots of
# generate_asset queued" in the dashboard, drop if your provider rate limits.
WORKER_CONCURRENCY="${WORKER_CONCURRENCY:-3}"

# Make sure homebrew tools (yt-dlp, ffmpeg, uv) and Postgres CLIs are on PATH.
# homebrew (yt-dlp/ffmpeg/uv), Postgres CLIs, npm-global (codex), LM Studio CLI.
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@16/bin:$HOME/.npm-global/bin:$HOME/.lmstudio/bin:$PATH"

echo "▶ web   : http://localhost:$PORT"
echo "▶ worker: $WORKER_KINDS  (concurrency=$WORKER_CONCURRENCY)"
echo

pids=()
cleanup() {
  echo
  echo "stopping…"
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  wait 2>/dev/null || true
}
trap cleanup INT TERM EXIT

pnpm exec next dev --port "$PORT" &
pids+=($!)

pnpm exec tsx workers/runner.ts --kinds "$WORKER_KINDS" --idle-ms 1500 --concurrency "$WORKER_CONCURRENCY" &
pids+=($!)

wait
