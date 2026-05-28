# Runtime settings

ChannelHelm's `/settings` page is a DB-backed, live-propagating runtime config layer. Operators change a value once; every Node process (the Next.js server + every worker) sees it within the LISTEN round-trip. No restart, no `.env` edits, no cache TTL drift.

Reference implementation pattern (mask-on-edit + DB-backed key/value): [`dojoclaw/src/app/api/settings/route.ts`](../../dojoclaw/src/app/api/settings/route.ts).

## Architecture in one paragraph

A `settings(key, value, encrypted, updated_at)` Postgres table holds runtime config. **Workers** (full daemon lifetime, long-running) call `loadSettingsIntoEnv()` + `subscribeSettingsChanges()` at boot in `workers/runner.ts`: the LISTEN client refreshes individual keys into `process.env` on every `pg_notify`. **Next.js** can't do this — Turbopack's instrumentation bundling refuses the `pg`/`dotenv` import chain — so it uses a lazy `ensureHydrated()` called from `/api/settings` GET and from `setSetting()` (idempotent, in-flight promise dedup). Every existing `process.env.X` consumer keeps working unchanged — **zero refactor**. Writes go through `setSetting(key, value)`, which upserts the row, applies the change locally to `process.env`, and fires `pg_notify('chs_settings', key)` so the worker pool refreshes its env.

## Why this shape

Three alternatives were considered and rejected:

1. **`await getSetting(key)` everywhere.** Would mean refactoring ~18 existing `process.env.X` reads to async, including paths deep in worker chains. Higher blast radius for the same outcome.
2. **Write to `.env`.** Doesn't propagate to running processes; doesn't survive container restarts cleanly; needs operator restart anyway. Also unsafe for secrets (file on disk, often committed by mistake).
3. **`src/instrumentation.ts` for Next.js too.** First attempt — failed in practice because Turbopack statically analyzes the dynamic-import target of the runtime gate, then tries to bundle `pg` + `dotenv` for the Edge runtime where `require('fs')` / `require('path')` don't resolve. The lazy `ensureHydrated()` path keeps the Node-only imports off the Edge bundle's analysis entirely.

DB + hydration + LISTEN is the same shape DojoClaw uses, and the same shape the operator (Thorsten) flagged as the reference when asking for this feature.

## The catalogue

`SETTINGS_CATALOGUE` in `src/lib/settings.ts` is the source of truth for what `/settings` shows and what `/api/settings` accepts. Anything not listed is refused by `setSetting()`.

| Key | Editable? | Sensitive | Used by |
|---|---|---|---|
| `ZERNIO_API_KEY` | ✓ live | yes | `workers/integrations/zernio.ts` |
| `ZERNIO_WEBHOOK_SECRET` | ✓ live | yes | `/api/webhooks/zernio` |
| `DOJOCLAW_API_URL` | ✓ live | no | `workers/integrations/dojoclaw.ts` |
| `DOJOCLAW_API_KEY` | ✓ live | yes | `workers/integrations/dojoclaw.ts` |
| `DOJOCLAW_WEBHOOK_SECRET` | ✓ live | yes | `/api/webhooks/dojoclaw` |
| `HF_TOKEN` | ✓ live | yes | `workers/kinds/transcribe_audio.ts` (diarization) |
| `CLOUDFLARE_TUNNEL_HOSTNAME` | ✓ live | no | `src/lib/media-sign.ts` |
| `MEDIA_URL_SECRET` | ✓ live | yes | `src/lib/media-sign.ts` |
| `MEDIA_REQUIRE_SIGNATURE` | ✓ live | no (`bool`) | `src/app/api/media/[...path]/route.ts` |
| `ALLOW_UNSIGNED_WEBHOOKS` | ✓ live | no (`bool`) | `src/lib/hmac.ts` |
| `MAX_UPLOAD_BYTES` | ✓ live | no (`number`) | `src/app/api/uploads/route.ts` |
| `DATABASE_URL` | **boot-only** | yes | `pg.Pool` at `src/db/client.ts` |
| `MEDIA_ROOT` | **boot-only** | no | every worker that spawns ffmpeg/ml |
| `LOCAL_BEARER_TOKEN` | **boot-only** | yes | `src/lib/auth.ts` |
| `PROVIDER_SECRET_KEY` | **boot-only** | yes | `src/lib/secret-box.ts` |

**Boot-only keys** appear on `/settings` read-only with an "edit .env and restart" hint. Mid-flight rotation of any of them breaks running workers (lost DB connections, lost auth tokens, undecryptable provider keys).

**LLM providers are not in this catalogue.** They live in the `llm_providers` table and are edited at `/providers` — a richer, multi-row, per-purpose editor with the same at-rest encryption story. The `/settings` page links there with a banner.

## File map

```
src/db/schema/settings.ts                   ← Drizzle table
src/lib/settings.ts                         ← catalogue, hydration (loadSettingsIntoEnv,
                                              ensureHydrated), writes (setSetting),
                                              LISTEN (subscribeSettingsChanges),
                                              table-existence probe
workers/runner.ts                           ← worker boot hook (load + subscribe at startup)
                                              — Next.js has no instrumentation hook on purpose;
                                              hydration is lazy via the API route
src/app/api/settings/route.ts               ← GET + PUT (ensureHydrated on entry)
src/app/settings/page.tsx                   ← editable page + migration-needed banner
src/components/settings/SettingsEditor.tsx  ← client editor rows
migrations/0005_settings.sql                ← CREATE TABLE
```

## Operator flows

### Setting a value the first time

1. `/settings` → row → type → **Save**.
2. The PUT round-trip upserts the row, fires `pg_notify`, and applies the change to `process.env` on the responding Next.js process.
3. Every other process LISTENing on `chs_settings` refreshes the same key from DB.

### Restart needed only after the worker code changes

The worker daemon (`tsx workers/runner.ts`) opens its LISTEN connection at startup. If you change `workers/runner.ts` itself, restart `pnpm dev:all`. Changing settings consumers (`process.env.X` readers) does NOT require a restart — they're already watching the live env. The Next.js side hydrates on demand, so no UI restart is ever needed for settings to take effect.

### Migration needed

On a fresh checkout where the migration hasn't run, `settingsTableExists()` returns false. The page shows a red banner: **"Settings table not migrated yet"** with the one-liner:

```bash
pnpm db:migrate
```

This applies `migrations/0005_settings.sql` (single `CREATE TABLE`, no destructive ops). After it returns, retry Save and the value persists. The restart-needed banner may appear next — see above.

### Boot-only changes

Edit `.env`, then:

```bash
# Ctrl-C the running dev:all session, then:
pnpm dev:all
```

The `/settings` page shows boot-only values read-only with this exact hint inline.

## API reference

### `GET /api/settings`

```json
{
  "items": [
    { "key": "ZERNIO_API_KEY", "value": "••••••••", "isSet": true,
      "sensitive": true, "kind": "string", "help": "…", "bootOnly": false },
    …
  ],
  "migrationNeeded": false,
  "subscriberStatus": "subscribed"
}
```

Secrets are masked. `subscriberStatus` is `"pending" | "subscribed" | "unavailable"`.

### `PUT /api/settings`

Body: `{ "KEY": "value", "KEY2": "value" }`. Per DojoClaw's pattern:

- Mask-placeholder submissions (`••••••••`) are silently skipped (means "no change").
- Boot-only keys 400 with `{ error: "boot-only — edit .env and restart" }`.
- Unknown keys 400 with `{ error: "unknown setting" }`.

Response:

```json
{ "ok": true, "changed": ["ZERNIO_API_KEY"], "errors": [] }
```

If *all* keys errored, status is 400; if some succeeded, status is 200 and the errors are in the response body.

## Adding a new editable setting

1. Add the key to `SETTINGS_CATALOGUE` in `src/lib/settings.ts` with `{ sensitive, kind, help }` (and `bootOnly: true` if it can't change mid-flight). That's all the UI needs — the form renders the right input for the `kind`.
2. Keep the consumer's `process.env.KEY` read exactly as-is. Hydration does the rest.
3. Add a `[editable @ /settings]` or `[BOOT-ONLY]` marker in `.env.example` next to the new key.
4. If the value should default to something on a zero-config install, set it in `.env.example` so it ends up in `.env`. Hydration is "DB > .env", so unset DB rows never clobber the env default.

## Things this system intentionally doesn't do

- **No cross-Mac fanout.** Notifications go through the local Postgres instance; if you ran workers on a different Mac connecting to the same DB, they'd subscribe too. There's no separate broadcast bus.
- **No history.** The table is upsert-only. If you need an audit log, add a `settings_history` table; out of scope for v1.
- **No per-brand scoping.** Settings are global. Brand-scoped config lives on `brands.*` JSONB fields (Zernio accounts, default profile, voice profile).
- **No structured config.** Values are flat strings (or strings that parse as numbers/booleans). Anything richer goes in its own table (e.g. `llm_providers`).
