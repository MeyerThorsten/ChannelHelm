#!/usr/bin/env bash
#
# Dev convenience: run the Next.js web server AND the worker daemon together
# so generation auto-starts when you add a video. Ctrl-C stops both.
#
# In production these are separate launchd services (infra/launchd/*); this
# script is only for single-Mac local dev.
#
# Env:
#   PORT               web server port (default 3000)
#   DATABASE_URL       inherited; falls back to .env

set -euo pipefail

PORT="${PORT:-3000}"
WORKER_KINDS="${WORKER_KINDS:-ingest,transcribe_audio,analyze_visual,fuse,analyze_intelligence,generate_asset,thumbnail_concepts,clip_render,dispatch,collect_signal,promote_voice_examples}"

# Make sure homebrew tools (yt-dlp, ffmpeg, uv) and Postgres CLIs are on PATH.
# homebrew (yt-dlp/ffmpeg/uv), Postgres CLIs, npm-global (codex), LM Studio CLI.
export PATH="/opt/homebrew/bin:/opt/homebrew/opt/postgresql@16/bin:$HOME/.npm-global/bin:$HOME/.lmstudio/bin:$PATH"

echo "▶ web   : http://localhost:$PORT"
echo "▶ worker: $WORKER_KINDS"
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

pnpm exec tsx workers/runner.ts --kinds "$WORKER_KINDS" --idle-ms 1500 &
pids+=($!)

wait
