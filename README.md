# ChannelHelm

Local-first video-to-publishing command center. Runs on the Mac fleet. The contract is the source of truth:

→ [`docs/channelhelm-technical-contract-v1.md`](docs/channelhelm-technical-contract-v1.md)

Stack: Next.js 15 (App Router, TS strict) + Drizzle ORM + PostgreSQL 16 on the M4 Max master. Workers are Node processes (`tsx workers/runner.ts`). Four MLX-bound steps live in `ml/` as Python CLI scripts. See `CLAUDE.md` / `AGENTS.md` for the operating manual.

## Fresh-checkout setup

```sh
pnpm install
cp .env.example .env       # fill in DATABASE_URL etc.
pnpm db:migrate            # apply migrations against local Postgres
pnpm smoke:schema          # inserts brand → source → package, prints, cleans up
```

## Common scripts

| Command              | What it does                                  |
|----------------------|-----------------------------------------------|
| `pnpm dev`           | Next.js dev server                            |
| `pnpm typecheck`     | `tsc --noEmit`                                |
| `pnpm lint`          | Biome check                                   |
| `pnpm db:generate`   | Generate a new Drizzle migration from schema  |
| `pnpm db:migrate`    | Apply migrations to `DATABASE_URL`            |
| `pnpm db:studio`     | Open Drizzle Studio                           |
