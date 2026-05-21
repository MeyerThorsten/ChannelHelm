# Session 01 — Next.js scaffold + Drizzle schema + initial migration

Paste this into Claude Code as your first message after `cd channelhelm && claude`.

---

Read `CLAUDE.md` and `docs/channelhelm-technical-contract-v1.md` Section 4 (PostgreSQL schema), §5.5 (processing profiles), and §5.6 (Node ↔ Python ML CLI contract). Confirm you understand the schema and the stack constraints before generating anything.

Your task for this session is **Step 1 of the §13 build sequence**: scaffold the Next.js project, define every table from §4 in Drizzle, generate the initial migration, and prove it with a smoke script. No API routes yet, no workers, no UI, no Python. Schema and scaffolding only.

## Concrete deliverables for this session

1. **`package.json`** with these dependencies:
   - Runtime: `next@^15`, `react@^18`, `react-dom@^18`, `drizzle-orm`, `pg`, `zod`, `ulid`, `dotenv`
   - Dev: `typescript`, `@types/node`, `@types/pg`, `@types/react`, `@types/react-dom`, `drizzle-kit`, `tsx`, `@biomejs/biome`, `vitest`, `@testcontainers/postgresql`
   - Scripts: `dev`, `build`, `start`, `lint` (biome), `typecheck` (`tsc --noEmit`), `db:generate` (`drizzle-kit generate`), `db:migrate` (`drizzle-kit migrate`), `db:studio` (`drizzle-kit studio`), `smoke:schema` (`tsx scripts/smoke-schema.ts`)
   - Package manager: pnpm — include a `"packageManager"` field

2. **Config files**:
   - `tsconfig.json` — Next.js strict TS preset, `paths` aliasing `@/*` to `src/*`
   - `next.config.mjs` — minimal, no experimental features
   - `biome.json` — sensible defaults, 2-space indent, single quotes
   - `drizzle.config.ts` — points at `src/db/schema.ts`, outputs to `migrations/`, reads `DATABASE_URL` from `.env`
   - `.env.example` — `DATABASE_URL`, `ZERNIO_API_KEY`, `DOJOCLAW_API_URL`, `DOJOCLAW_API_KEY`, `OPENCLAW_BASE_URL`, `LM_STUDIO_DEFAULT_HOST`, `LM_STUDIO_PREMIUM_HOST`, `MEDIA_ROOT`, `CLOUDFLARE_TUNNEL_HOSTNAME`, `LOCAL_BEARER_TOKEN`
   - `.gitignore` — Node + Next.js + macOS defaults, plus `.env`, `media/`, `migrations/meta/*.json` (Drizzle journal commits but caches don't)

3. **Drizzle schema at `src/db/schema.ts`** — every table from contract §4 in Drizzle TypeScript form:
   - `brands` — including the `default_processing_profile` column from §5.5
   - `sources`
   - `packages` — including `processing_profile` from §5.5
   - `assets` — including the full `provenance`, `dispatch`, `signals` JSONB columns
   - `jobs` — including `idempotency_key` with the partial unique index `WHERE idempotency_key IS NOT NULL`
   - `dispatches`
   - `webhook_events` — including `source_event_id` and the unique index on `(source, source_event_id)`
   - `signals`
   - `voice_examples`
   - Every index from §4 must be present
   - JSONB columns use Drizzle's `jsonb(...).$type<T>()` with Zod-inferred TS types where the shape is non-trivial (intelligence, payload, provenance, dispatch, signals, voice_profile, dojoclaw_sites, approval_required_for, auto_dispatch_for, routing). For now use loose types (e.g. `Record<string, unknown>` for `intelligence`) — proper Zod schemas come in Session 02.
   - Use `text('...').$default(() => ulid('prefix_'))` for ID columns. Put the ULID helper in `src/lib/ids.ts`.

4. **DB client at `src/db/client.ts`** — exports a Drizzle instance backed by `pg.Pool`. Reads `DATABASE_URL` from env. Connection pool size 10. Does NOT export the raw pool — workers/queue.ts will create its own.

5. **Initial migration**:
   - Run `pnpm db:generate` to produce `migrations/0000_*.sql`
   - The generated SQL must match §4 exactly. If Drizzle's output differs (e.g. constraint naming, index order, generated default values), reconcile by adjusting the schema, not by hand-editing the SQL.
   - Include the migration in the deliverable so I can inspect before applying.

6. **Smoke script at `scripts/smoke-schema.ts`**:
   - Connects to the DB
   - Inserts one brand (`brd_thorstenmeyerai`, slug `thorstenmeyerai`, name `Thorsten Meyer AI`, default_processing_profile `standard_audio_visual`)
   - Inserts one source (kind `youtube_url`, origin_url `https://www.youtube.com/watch?v=test`, brand_id from above)
   - Inserts one package (status `draft`, processing_profile `standard_audio_visual`, source_id and brand_id from above)
   - Reads all three rows back, prints them
   - Cleans up (DELETEs in reverse FK order)
   - Returns exit code 0 on success

7. **README.md** — 25 lines max. Points at `docs/channelhelm-technical-contract-v1.md`. Lists the four commands a fresh checkout needs: `pnpm install`, `cp .env.example .env`, `pnpm db:migrate`, `pnpm smoke:schema`.

## What NOT to do this session

- Do not generate any API routes (`app/api/*`).
- Do not generate any UI (`app/page.tsx`, components, etc.).
- Do not generate worker code under `workers/`.
- Do not generate any Python under `ml/`.
- Do not generate prompts under `prompts/`.
- Do not write Zod schemas for asset payloads yet — Session 02 territory.
- Do not deviate from §4 column names, types, or constraints. If you think a field should be added, stop and ask before changing the contract.
- Do not auto-run `pnpm db:migrate` against the real DB. Show me the generated SQL and let me run it.

## Acceptance criteria

- `pnpm install` completes cleanly with no peer-dep warnings of note.
- `pnpm typecheck` is clean.
- `pnpm lint` is clean.
- `pnpm db:generate` produces `migrations/0000_*.sql` that I can read and that matches §4.
- After I run `pnpm db:migrate` against a fresh local Postgres, `pnpm smoke:schema` prints the three rows and exits 0.
- Every file under 200 lines. If `src/db/schema.ts` would exceed 200 lines because the schema is large, split into `src/db/schema/{brands,sources,packages,assets,jobs,dispatches,webhooks,signals,voice_examples}.ts` and re-export from `src/db/schema.ts`.

## Session flow

1. Confirm you've read CLAUDE.md and §4 + §5.5 + §5.6 of the contract. List the 9 tables you're about to define and any non-obvious column choices.
2. Generate `package.json` and the four config files first.
3. Generate `src/lib/ids.ts` and `src/db/client.ts`.
4. Generate the Drizzle schema (one table per commit if you're checkpointing; one file if it fits comfortably).
5. Run `pnpm db:generate` and show me the resulting SQL.
6. Generate `scripts/smoke-schema.ts` and `README.md`.
7. Stop. I'll inspect the SQL, run the migration, and run the smoke script. Then Session 02 opens.

If at any point the contract is ambiguous or Drizzle's idioms force a constraint that differs from §4, stop and surface the conflict rather than guessing. The contract is at `docs/channelhelm-technical-contract-v1.md` and is at v1.3.

Go.
