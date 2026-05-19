# launchd templates

Production process supervision per CLAUDE.md. These are templates — copy
to `~/Library/LaunchAgents/` on each Mac, edit the paths/kinds, then
`launchctl load`.

| Plist | Where it runs | What it does |
|---|---|---|
| `com.channelhelm.web.plist` | M4 Max master | Next.js dev/start server |
| `com.channelhelm.worker-master.plist` | M4 Max | `--kinds ingest,fuse,clip_render,dispatch` |
| `com.channelhelm.worker-llm.plist` | M3 Ultra (96 GB or 512 GB) | `--kinds transcribe_audio,analyze_visual,analyze_intelligence,generate_asset,thumbnail_concepts` |
| `com.channelhelm.worker-mini.plist` | Each Mac Mini | `--kinds generate_asset,dispatch,collect_signal` |
| `com.channelhelm.recurring.plist` | M4 Max | Runs `scripts/enqueue-recurring.ts` every 15 minutes |

## Install (per Mac)

```bash
cp infra/launchd/<plist> ~/Library/LaunchAgents/
# Edit the WorkingDirectory and EnvironmentVariables sections to point at
# your local checkout and .env values.
launchctl load ~/Library/LaunchAgents/<plist>
launchctl start <plist-Label>
```

Logs land under `/tmp/channelhelm-*.log` by default; change the
`StandardOutPath` / `StandardErrorPath` keys if you want them elsewhere.

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/<plist>
rm ~/Library/LaunchAgents/<plist>
```

## Note on `launchd` semantics

- `KeepAlive=true` restarts the process if it exits non-zero. That's what
  you want for a long-running worker.
- `RunAtLoad=true` starts on `launchctl load` and again on every reboot.
- `StartInterval=N` re-runs every N seconds (used by the recurring
  enqueuer plist).
