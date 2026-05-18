# ChannelHelm — Codex project context

This file is loaded automatically at the start of every Codex session. Read it fully before doing anything else.

## What ChannelHelm is

ChannelHelm is a **local-first video-to-publishing command center**. It runs on Thorsten Meyer's Mac fleet. Source artifacts (YouTube URLs, uploaded videos, podcasts, webinars, transcripts) come in. ChannelHelm understands them via a four-layer pipeline (audio + visual + fusion + intelligence) and produces a canonical **Publishing Package** containing every derivative asset. Editorial assets route to **DojoClaw** (local HTTP API on the LAN). Social and rendered-clip assets route to **Zernio** (external cloud API). ChannelHelm itself owns routing, approval, state, and learning.

## The source of truth

**`docs/channelhelm-technical-contract-v1.md`** is the load-bearing spec. Before generating any code that touches the Publishing Package, schema, workers, or integrations, read the relevant section. The contract is at **v1.3** as of session start. Section numbers referenced below match that version.

When the contract and this file disagree, the contract wins. Update this file rather than diverging.

## Stack — non-negotiables

### Application layer (TypeScript, Node)

- **Database:** PostgreSQL 16 on the M4 Max master. Single Postgres instance, no clustering. ULIDs as `TEXT`.
- **Web app:** Next.js 15+ (App Router) + TypeScript strict mode. Server Components by default, Server Actions for mutations, API routes (`app/api/.../route.ts`) for webhook receivers and external integrations.
- **ORM:** Drizzle ORM with `drizzle-kit` migrations. Schema lives at `src/db/schema.ts` and mirrors §4 of the contract exactly.
- **DB driver:** `pg` (node-postgres) under Drizzle; also used directly by the queue layer.
- **Job queue:** Custom thin queue (~150 lines) at `workers/queue.ts` using `SELECT FOR UPDATE SKIP LOCKED` from §6.1 verbatim. NOT Graphile Worker, NOT BullMQ, NOT Redis.
- **Workers:** Node processes via `tsx workers/runner.ts --kinds X`, one process per kind set, managed by `launchd` per Mac.
- **UI components:** shadcn/ui + Tailwind.
- **Validation:** Zod schemas, shared between API routes and workers.
- **LLM client:** `openai` npm package pointed at LM Studio's OpenAI-compatible endpoint. Route via OpenClaw at `192.168.0.156:18789` when available.
- **Zernio integration:** Node `zernio` SDK preferred. Thin typed `fetch` fallback module at `workers/integrations/zernio_http.ts` is allowed when the SDK lags; same Zod schemas, same dispatch logging.

### ML CLI layer (Python — isolated to four scripts)

- **Runtime:** Python 3.12 managed by `uv`. A single `pyproject.toml` at `ml/pyproject.toml`.
- **Scripts:** `ml/transcribe.py` (MLX Whisper large-v3), `ml/diarize.py` (pyannote + WhisperX align), `ml/describe_frames.py` (mlx-vlm Qwen2.5-VL), `ml/ocr.py` (Apple Vision via pyobjc).
- **Invocation:** `uv run python ml/{script}.py --input ... --output ...` spawned from Node workers via `child_process.spawn`. JSON status to stdout, large outputs to file. Contract is in §5.6.
- **No FastAPI, no Flask, no shared service.** Each Python file is a CLI, period.

### Tooling

- **Package manager:** pnpm.
- **Lint/format:** Biome (single tool, fast).
- **Type check:** `tsc --noEmit` in CI.
- **Tests:** Vitest + `@testcontainers/postgresql` for real Postgres in tests. No SQLite shims.
- **Dev runtime:** `tsx` for running TypeScript directly.
- **Process management:** `pm2` for dev, `launchd` for production.

## Hard constraints

- **Local-first.** v1 does not deploy to cloud SaaS. The only external cloud dependency is Zernio's API.
- **No Convex.** Considered and rejected. Use PostgreSQL.
- **DojoClaw is a local HTTP service.** Call it over `http://m4max.local:8788/` via `fetch`. Do not import DojoClaw code or share its database connection.
- **Multi-brand is root.** Every entity below `brands` is brand-scoped. No cross-brand reads outside admin views.
- **Uniform provenance.** Every generated artifact (LLM text, transcripts, frame descriptions, OCR, scene log, rendered clips) carries `{provider, model, host, prompt_version, input_refs, generated_at}`. No exceptions.
- **Idempotency keys are mandatory** for enqueued jobs of these kinds: `ingest`, `transcribe_audio`, `analyze_visual`, `fuse`, `analyze_intelligence`, `generate_asset`, `clip_render`, `dispatch`, `collect_signal`. Conventions are inline in the §4 schema comments.
- **Webhook idempotency.** Inbound events must collide on `(source, source_event_id)` and be swallowed at INSERT.
- **`*_plan` assets are never dispatched.** They are blueprints consumed by the `clip_render` worker, which produces `rendered_*` assets. Only `rendered_*` and text/editorial assets are dispatchable. Attempting to dispatch a `*_plan` is a programming error and the worker must throw.
- **Python is isolated to `ml/`.** No Python code anywhere else in the repo. If a step needs Python and it's not one of the four ML scripts, that's a sign to reconsider rather than to expand the Python surface.

## Repo layout

```
channelhelm/
├── AGENTS.md                           ← you are here
├── README.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── next.config.mjs
├── docs/
│   └── channelhelm-technical-contract-v1.md
├── src/
│   ├── app/                            ← Next.js App Router
│   │   ├── page.tsx                    ← dashboard root
│   │   ├── packages/[id]/page.tsx
│   │   └── api/
│   │       ├── brands/route.ts
│   │       ├── sources/route.ts
│   │       ├── packages/route.ts
│   │       ├── assets/[id]/route.ts
│   │       └── webhooks/
│   │           ├── zernio/route.ts
│   │           └── dojoclaw/route.ts
│   ├── components/                     ← React Server + Client components
│   ├── db/
│   │   ├── schema.ts                   ← Drizzle schema, mirrors §4
│   │   ├── client.ts                   ← Drizzle DB client
│   │   └── types.ts                    ← inferred row types
│   ├── lib/
│   │   ├── schemas.ts                  ← shared Zod schemas
│   │   ├── ids.ts                      ← ULID helpers
│   │   └── auth.ts                     ← local bearer-token auth
│   └── server-actions/                 ← Next.js Server Actions
├── workers/
│   ├── runner.ts                       ← claim → dispatch → ack loop entry point
│   ├── queue.ts                        ← SKIP LOCKED queue (the ONLY INSERTer to jobs)
│   ├── kinds/
│   │   ├── ingest.ts
│   │   ├── transcribe_audio.ts
│   │   ├── analyze_visual.ts
│   │   ├── fuse.ts
│   │   ├── analyze_intelligence.ts
│   │   ├── generate_asset.ts
│   │   ├── clip_render.ts
│   │   ├── dispatch.ts
│   │   └── collect_signal.ts
│   └── integrations/
│       ├── ml_subprocess.ts            ← spawn helper for ml/*.py
│       ├── lm_studio.ts                ← openai client wrapper
│       ├── ffmpeg.ts                   ← spawn helper for ffmpeg
│       ├── ytdlp.ts                    ← spawn helper for yt-dlp
│       ├── dojoclaw.ts                 ← fetch wrapper
│       ├── zernio.ts                   ← SDK wrapper
│       └── zernio_http.ts              ← thin typed fetch fallback (only if needed)
├── ml/                                 ← Python (the ONLY Python in the repo)
│   ├── pyproject.toml
│   ├── _lib.py                         ← shared CLI scaffolding + JSON envelope
│   ├── transcribe.py
│   ├── diarize.py
│   ├── describe_frames.py
│   └── ocr.py
├── migrations/                         ← drizzle-kit generated
├── prompts/                            ← asset-type prompts, versioned
│   ├── linkedin_post.v1.md
│   ├── article_brief.v1.md
│   └── ...
├── scripts/                            ← one-off ops, seed data, smoke tests
└── .env.example
```

Place new files according to this layout. Do not invent new top-level directories without updating this file first.

## Coding conventions

- **TypeScript:** strict mode, no `any` without a `// why` comment, prefer `unknown` + narrowing. Use `satisfies` for object-literal type checking.
- **Async:** `async/await` everywhere. No raw promises.
- **Database access:** Drizzle for application reads/writes. Raw `pg` only inside `workers/queue.ts`. No ad-hoc SQL outside that.
- **Job enqueue:** ONLY through `workers/queue.ts::enqueue(kind, payload, idempotencyKey, priority?)`. Direct INSERTs into `jobs` from anywhere else are forbidden.
- **Provenance:** every function that produces an artifact returns it wrapped with a `Provenance` Zod schema. Workers attach the wrapper to the `provenance` JSONB column before commit.
- **Prompts:** stored under `prompts/{asset_type}.v{N}.md` with YAML frontmatter (`name`, `version`, `inputs`, `model`). The `generate_asset` worker reads the file at runtime, not from a TS string constant.
- **Zod schemas:** authoritative for asset payload shapes. Drizzle JSONB columns are typed as Zod-inferred TS types via Drizzle's `$type<>()`.
- **Worker structure:** one TS file per kind under `workers/kinds/`. Each exports a single `run(job: Job): Promise<void>` function. The runner dispatches by kind.
- **Subprocess invocation:** always through `workers/integrations/ml_subprocess.ts` (for Python), `ffmpeg.ts`, `ytdlp.ts` (for system tools). Direct `child_process.spawn` elsewhere is forbidden.

## Naming conventions

- IDs: ULIDs as TEXT with type prefixes — `brd_`, `src_`, `pkg_`, `ast_`, `djw_` (DojoClaw job), `prof_` (Zernio profile), `acc_` (Zernio account).
- Asset types: snake_case singular — `linkedin_post`, `short_clip_plan`, `rendered_short_clip`.
- Worker job kinds: snake_case verbs — `transcribe_audio`, `analyze_visual`, `clip_render`.
- TS variables: camelCase. DB columns and JSON keys: snake_case. Use Drizzle's column aliases to map.
- Status enums: see §2.1 (assets) and §10 (packages). Do not invent new status values without updating both this file and the contract.

## Pipeline summary (read the contract for detail)

```
ingest
  └─→ transcribe_audio ┐
                       ├─→ fuse ─→ analyze_intelligence ─→ generate_asset ─┐
      analyze_visual ──┘                                                    ├─→ ready_for_review
                                                                clip_render ┘             │
                                                                                          ▼
                                                                            (operator approval)
                                                                                          │
                                                                                          ▼
                                                                                       dispatch
                                                                                     /    |
                                                                                    /     |
                                                                              DojoClaw   Zernio
```

## Processing profiles

Every package runs under one of: `fast_audio_only`, `standard_audio_visual`, `premium_multimodal`. See §5.5. The profile is on `packages.processing_profile`, defaults from `brands.default_processing_profile`, propagated into every artifact's `provenance.profile`.

## What NOT to do

- Do not write Python anywhere outside `ml/`. The four ML scripts are the entire Python surface.
- Do not write a FastAPI service, a Flask service, or any Python HTTP service. The contract explicitly rejected this in §5.6.
- Do not deploy anything to Vercel, Fly.io, Railway, or any cloud platform. ChannelHelm runs locally.
- Do not import DojoClaw as a package. It is a separate service called over HTTP via `fetch`.
- Do not call Zernio with raw `fetch` outside `workers/integrations/zernio.ts` or `zernio_http.ts`. Single module, shared Zod schemas, logs to `dispatches` table.
- Do not put long-running work (transcription, VLM, ffmpeg) inside Next.js API routes or Server Actions. That's what workers are for. The app enqueues; workers do.
- Do not generate prompts inline in TS source. Load from `prompts/{asset_type}.v{N}.md`.
- Do not add fields to `assets.payload` without documenting the new shape in §2.3 of the contract first.
- Do not write code that assumes single-brand. Always scope by `brand_id`.
- Do not skip provenance. If a function generates anything, it returns a wrapper with full provenance.
- Do not skip idempotency keys when enqueuing jobs of the kinds listed in the §4 schema comments.
- Do not use raw `pg.Pool.query` outside `workers/queue.ts`. Drizzle everywhere else.
- Do not install Graphile Worker, BullMQ, Bee-Queue, or any other Node job queue library. The queue is in-repo.

## Session-start checklist

At the start of every Codex session, do this:

1. Read `docs/channelhelm-technical-contract-v1.md` sections relevant to the task. The TOC at the top of the contract makes this fast.
2. Confirm what step of the §13 build sequence the current task corresponds to. If it's not on the sequence, ask the operator before generating code.
3. Check `git status` and `git log -5` for context on what was last done.
4. State your plan in 5 lines or fewer before generating code.
5. Generate code in small, runnable chunks. Run the relevant tests/migrations after each chunk.

## Operator preferences (Thorsten)

- Prefers implementation-ready output over outlines or questions.
- Will push back when an approach doesn't fit existing constraints. Push back is signal, not friction.
- Reads diffs and runs migrations himself rather than letting the agent auto-apply destructive operations. Show the migration; he runs it.
- Uses MacWhisper Pro + Superwhisper for voice dictation into Codex. Long voice-dictated prompts are normal; parse intent rather than literal phrasing.
- Working from Iffeldorf, Germany. UTC+1 / UTC+2 depending on DST. Use UTC for all ISO timestamps in code.

## Codex review mode

When asked to review:
- Do not edit files.
- Do not commit.
- Do not open pull requests.
- Create GitHub Issues only for concrete, actionable problems.
- One issue per problem.
- Search existing issues first to avoid duplicates.
- Prefer Critical/High findings over style comments.
- Treat ChannelHelm as local-first infrastructure, not SaaS.

---

**End of AGENTS.md.** The contract is the source of truth. This file is the operating manual.
