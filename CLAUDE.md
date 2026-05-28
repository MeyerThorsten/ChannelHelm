# ChannelHelm — Claude Code project context

This file is loaded automatically at the start of every Claude Code session. Read it fully before doing anything else.

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
- **Workers:** Node processes via `tsx workers/runner.ts --kinds X --concurrency N`, one process per kind set, managed by `launchd` per Mac. Default concurrency is 3 — each slot is an independent claim→run→ack loop; SKIP LOCKED in the queue is the only mutex (no in-process locking). LLM-bound kinds (generate_asset, analyze_intelligence) benefit most. Tune via `WORKER_CONCURRENCY` env var or the `--concurrency` flag.
- **UI components:** shadcn/ui + Tailwind.
- **Validation:** Zod schemas, shared between API routes and workers.
- **LLM client:** Pluggable provider abstraction in `workers/integrations/llm/` (modeled on DojoClaw's `src/lib/llm`). Providers are configured in the `llm_providers` table (managed at `/providers`) — `openai-compatible` (OpenAI, OpenRouter, Ollama, LM Studio, OpenClaw) and `anthropic` (Messages API). `complete()` in `workers/integrations/lm_studio.ts` resolves a provider via `getProvider(profile)` (purpose-match → default → env fallback) and calls it over `fetch`. When the table is empty it auto-seeds an LM Studio provider from `LM_STUDIO_*`/`OPENCLAW_BASE_URL` env, so the prior env-only behavior still works with zero config. (This supersedes the original "use the `openai` npm package" note — the operator asked for DojoClaw-style multi-provider support.)
- **Image generation (AI thumbnails):** Pluggable image-provider abstraction in `workers/integrations/image/` (sister to the LLM layer — `types.ts` `ImageProvider`, `runware.ts` first impl ported from DojoClaw's runware-client, `get_image_provider.ts` resolver + `downloadImage`). Image providers live in the SAME `llm_providers` table with `category = 'image'` (chat providers are `category = 'text'`); `getProvider`/`getImageProvider` filter by category so they never cross. Configured at `/providers`. The `thumbnail_concepts` worker uses AI generation when an image provider is configured (LLM builds visual concepts from the analysis via `prompts/thumbnail_image.v1.md` → image provider renders → `downloadImage` to disk → `renderThumbnail` produces a plain + a headline-overlay variant via ffmpeg `drawtext`), and FALLS BACK to ffmpeg frame extraction when none is configured. Audio-only profiles (`fast_audio_only`, `transcription_only`) skip thumbnails entirely. Generated images are always downloaded to MEDIA_ROOT (the YouTube `thumbnails.set` uploader + `/api/media` need local bytes) — unlike DojoClaw which keeps CDN URLs.
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
├── CLAUDE.md                           ← you are here
├── README.md
├── package.json
├── pnpm-lock.yaml
├── tsconfig.json
├── biome.json
├── drizzle.config.ts
├── next.config.mjs
├── docs/
│   ├── channelhelm-technical-contract-v1.md
│   └── settings.md                     ← runtime settings architecture (DB→env + pg_notify)
├── src/
│   ├── app/                            ← Next.js App Router
│   │   ├── page.tsx                    ← dashboard root
│   │   ├── settings/page.tsx           ← editable runtime settings (banners + per-row save)
│   │   ├── packages/[id]/page.tsx
│   │   └── api/
│   │       ├── brands/route.ts
│   │       ├── sources/route.ts
│   │       ├── packages/route.ts
│   │       ├── assets/[id]/route.ts
│   │       ├── settings/route.ts       ← GET/PUT (DojoClaw mask-placeholder pattern)
│   │       └── webhooks/
│   │           ├── zernio/route.ts
│   │           └── dojoclaw/route.ts
│   ├── components/                     ← React Server + Client components
│   │   ├── settings/SettingsEditor.tsx ← client editor (mask, toggles, per-row save)
│   │   ├── ui/Modal.tsx                ← portal-based modal primitive (Escape + scroll lock)
│   │   └── studio/shorts/              ← per-Short editor (ShortsList · ShortsEditor · Timeline · TranscriptPanel · SubtitleStylePanel · PreviewPlayer · ClipPublishOptions)
│   ├── db/
│   │   ├── schema.ts                   ← Drizzle schema, mirrors §4
│   │   ├── client.ts                   ← Drizzle DB client
│   │   └── types.ts                    ← inferred row types
│   ├── lib/
│   │   ├── schemas.ts                  ← shared Zod schemas
│   │   ├── ids.ts                      ← ULID helpers
│   │   ├── auth.ts                     ← local bearer-token auth
│   │   ├── secret-box.ts               ← AES-256-GCM for at-rest secrets
│   │   ├── settings.ts                 ← runtime settings catalogue, hydration, LISTEN, writes
│   │   ├── word-snap.ts                ← word-boundary snap helpers for Shorts editor
│   │   └── ass-subtitles.ts            ← ASS subtitle file emitter (6 animation styles)
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
│   │   ├── collect_signal.ts
│   │   ├── archive_package.ts          ← Option B / storage lifecycle: post-publish move to ARCHIVE_ROOT
│   │   └── experiment_tick.ts          ← v1.5 Helm Signal: self-run title/thumbnail A/B rotation + winner decision
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
- **Runtime settings:** every consumer keeps reading `process.env.X` as before. The `settings` table (DB-backed) hydrates into `process.env` two different ways: workers call `loadSettingsIntoEnv()` + `subscribeSettingsChanges()` at boot in `workers/runner.ts` (full LISTEN-driven live propagation). The Next.js side uses request-entry lazy hydration: any route/page that reads runtime-editable env keys calls `hydrateRuntimeSettingsForRoute(routeName)` before touching `process.env`; `setSetting()` also calls `ensureHydrated()` defensively. `/api/settings` GET/PUT require `Authorization: Bearer $LOCAL_BEARER_TOKEN`; the dashboard saves through `src/server-actions/settings.ts::saveSettingValue`. Cross-process propagation is via `pg_notify('chs_settings', key)`. Writes go ONLY through `setSetting(key, value)` in `src/lib/settings.ts` — never INSERT into `settings` directly. New runtime-editable env keys MUST be added to `SETTINGS_CATALOGUE` in `src/lib/settings.ts`; boot-only keys (`DATABASE_URL`, `MEDIA_ROOT`, `LOCAL_BEARER_TOKEN`, `PROVIDER_SECRET_KEY`) carry `bootOnly: true` and stay read-only in the UI. See `docs/settings.md`.
- **LLM providers** are NOT settings — they live in the `llm_providers` table edited at `/providers` (DojoClaw-style provider editor with at-rest key encryption, per-purpose routing). **Per-provider concurrency (v1.5):** the `max_concurrent` column (0 = unlimited) caps in-flight requests via a process-wide semaphore in `workers/integrations/llm/semaphore.ts` — the resolver wraps `chat()`. This is an outbound-rate guard, NOT a job mutex (SKIP LOCKED remains the only mutex).
- **Helm Signal feedback loop (v1.5):** the A/B experiment engine (`experiment_tick`) writes winners to `voice_examples` — titles as `youtube_title_set`, thumbnails as `thumbnail_concept` (the winning concept's `visual_prompt`, which the `thumbnail_concepts` worker reads back as prompt guidance). `fuse` stores a lexicon `intelligence.sentiment_curve` (`src/lib/sentiment.ts`, no inference) that the clip planner + Studio sparkline consume. `collect_signal` pulls real retention from the YouTube Analytics API (`yt-analytics.readonly` scope) into `signals`; `analyze_intelligence` fits a per-brand least-squares retention calibration (`src/lib/retention-calibration.ts`) and stores `analysis.retention.calibrated_estimate` (identity until ≥3 paired samples).
- **Visual phase sampling:** the `analyze_visual` worker uses two independent sample passes. OCR samples densely (fps in `OCR_FPS_BY_PROFILE` — 0.5 for `standard_audio_visual`, 1 for `premium_multimodal`) at full source resolution. VLM samples sparsely at scene-cut timestamps via `pickVlmTimestamps()` + at most one frame per 30 s of static gap, downscaled to 768 px long-axis. Both subprocesses run in `Promise.all`. Per-frame VLM cost dominates; this combination is ~12–14× faster than the original dense-fps-1 approach on a typical 8-min video.
- **Worker concurrency safety:** the queue's `SELECT FOR UPDATE SKIP LOCKED` is the only mutex. When parallelising more workers, keep handlers per-asset (or per-row) idempotent — e.g. `markReadyForReviewIfComplete` and `recomputePackageDispatchState` are safe to call from N concurrent generate_asset/dispatch slots because they're status-update-only and the final state is deterministic.
- **Shorts editor:** the `short_clip_plan` asset is the EDITABLE source of truth for per-clip metadata (title/description/tags/trim/styling/publish_options). The `rendered_short_clip` asset is a build output — `clip_render` UPSERTs it keyed by `(plan_asset_id, clip_index)` and copies the plan's editorial fields into the rendered payload. Re-renders bump `render_rev` and re-use the same asset id while the rendered row is non-terminal; once a rendered row is `dispatched` or `published`, both `renderClip` and `clip_render` must refuse to overwrite its bytes. Delete is a plan-level soft delete (`deleted: true`) that keeps `clip_index` stable and preserves terminal rendered rows. Word-snap (`src/lib/word-snap.ts`) runs both client-side (Timeline) and server-side (clip_render defensive snap) — never trim mid-word. ASS subtitle emission (`src/lib/ass-subtitles.ts`) replaces VTT when the operator picks a `styling` block; 6 animations supported (Word Highlight, Pop, Single Word, Typewriter, Motion, Banner). Operator edits the plan; the worker rebuilds the file. NEVER persist operator edits on `rendered_short_clip` — they'd be lost on re-render.
- **Storage lifecycle (Options A + B):** Stage-1 pipeline artifacts (`audio.wav`, `frames_ocr/`, `frames_vlm/`, `ocr.json`, `frame_descriptions.json`, `frame_manifest_*.json`, `frame_index.json`, `scene_log.json`) are deleted at the tail of each producing worker. The escape hatch is `KEEP_PIPELINE_ARTIFACTS=1` (debugging only — keeps the WAV, frames, and intermediate JSONs on disk). Stage-3 (`original.mp4` + `clips/`) is moved to `ARCHIVE_ROOT` by the `archive_package` worker, fanned out by `scripts/enqueue-recurring.ts` once a package's latest successful dispatch is older than `ARCHIVE_AFTER_DAYS` (default 14) AND `packages.archived_at IS NULL`. Per source, the file move only happens when the LAST unarchived package on that source is being archived (sibling packages keep the bytes pinned). `clip_render` reads `original.mp4` from `source.archive_path` as a fallback when the local copy is gone, but always writes the rendered MP4 to the LOCAL `clipsDir` so dispatch's `mediaUrlFor` (MEDIA_ROOT-relative) keeps resolving. `ARCHIVE_ROOT` is bootOnly; `ARCHIVE_AFTER_DAYS` + `ARCHIVE_DELETE_CLIPS` are runtime-editable via /settings. Setting `ARCHIVE_ROOT` to empty disables the feature entirely (recurring enqueuer no-ops the archive block). See `public/storage-lifecycle.html` for the operator-facing rationale.

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
  - **Documented exception (Content Studio):** interactive *single-asset* regeneration runs the LLM synchronously in `src/server-actions/regenerate.ts` via the shared `workers/lib/generate.ts::generateAssetContent`. This is a bounded, text-only call (~10–30s) where enqueue+poll would force a "is a worker running?" dependency that ruins the studio UX. The bulk pipeline (`generate_asset` worker) still goes through the queue. Heavy ML (transcription/VLM/ffmpeg) stays worker-only — no exceptions there.
- Do not generate prompts inline in TS source. Load from `prompts/{asset_type}.v{N}.md`.
- Do not add fields to `assets.payload` without documenting the new shape in §2.3 of the contract first.
- Do not write code that assumes single-brand. Always scope by `brand_id`.
- Do not skip provenance. If a function generates anything, it returns a wrapper with full provenance.
- Do not skip idempotency keys when enqueuing jobs of the kinds listed in the §4 schema comments.
- Do not use raw `pg.Pool.query` outside `workers/queue.ts`. Drizzle everywhere else.
- Do not install Graphile Worker, BullMQ, Bee-Queue, or any other Node job queue library. The queue is in-repo.

## Session-start checklist

At the start of every Claude Code session, do this:

1. Read `docs/channelhelm-technical-contract-v1.md` sections relevant to the task. The TOC at the top of the contract makes this fast.
2. Confirm what step of the §13 build sequence the current task corresponds to. If it's not on the sequence, ask the operator before generating code.
3. Check `git status` and `git log -5` for context on what was last done.
4. State your plan in 5 lines or fewer before generating code.
5. Generate code in small, runnable chunks. Run the relevant tests/migrations after each chunk.

## Operator preferences (Thorsten)

- Prefers implementation-ready output over outlines or questions.
- Will push back when an approach doesn't fit existing constraints. Push back is signal, not friction.
- **Execute actions, don't hand them off** ("always do the action for me"). Run migrations, deploys, scripts, and setup steps directly. Still SHOW the migration/diff. Confirm before genuinely irreversible or destructive operations. For steps only a human can complete (e.g. a browser OAuth consent), drive it as far as possible (open the page) and hand off only the final click. (Supersedes the earlier "show the migration; he runs it.")
- Uses MacWhisper Pro + Superwhisper for voice dictation into Claude Code. Long voice-dictated prompts are normal; parse intent rather than literal phrasing.
- Working from Iffeldorf, Germany. UTC+1 / UTC+2 depending on DST. Use UTC for all ISO timestamps in code.

---

**End of CLAUDE.md.** The contract is the source of truth. This file is the operating manual.
