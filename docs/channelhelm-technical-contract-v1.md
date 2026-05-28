# ChannelHelm v1 — Technical Contract

**Version.** v1.3 — stack flip. Backend and workers move from Python/FastAPI to TypeScript/Next.js. PostgreSQL, schema, scene log, integration contracts, provenance, idempotency, processing profiles, and approval workflow are unchanged. New: Node ↔ Python ML CLI contract (§5.6) for the four MLX-bound steps that must remain in Python. See §14 for the full changelog.

Earlier: v1.2 — cleanup-review patches. `*_plan` assets are blueprints (not dispatchable); `rendered_*` assets are the dispatchable artifacts; approval workflow state machine matches the worker chain; processing profiles; uniform provenance; webhook and job idempotency keys.

v1.1 — adds the four-layer video understanding pipeline (audio + visual + fusion + intelligence) and the scene log schema.

**Document scope.** This is the load-bearing technical spec for ChannelHelm v1. It defines the canonical Publishing Package object, the PostgreSQL schema, the worker queue pattern, the local Mac fleet topology, the DojoClaw and Zernio integration contracts, the approval workflow state machine, and the Helm Signal feedback loop. Everything else — UI, MVP build order, Claude Code prompts — is downstream of what is locked here.

**Status of decisions in this document.** Every section below contains a committed decision, not a survey of options. Where alternatives were considered, the rejected option is named and the reason is one sentence.

---

## 1. Architecture overview

ChannelHelm v1 is a **local-first** publishing intelligence system that runs on Thorsten Meyer's existing Mac fleet. It does not deploy to cloud SaaS infrastructure in v1. It mirrors the topology already proven by DojoClaw: a single PostgreSQL master holds all state, a job queue uses row-level locking inside Postgres rather than Redis or RabbitMQ, and worker processes run as plain Python daemons on multiple Macs in the fleet. The only external dependency is Zernio, called over HTTPS for social publishing and scheduling. DojoClaw is called as a local service on the LAN, not a cloud API.

The system is structured as four conceptual layers:

```
┌────────────────────────────────────────────────────────────────┐
│            (Browser → Next.js app on the M4 Max)                │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│             ChannelHelm Next.js app (App Router)                │
│        UI + Server Actions + API routes + webhook receivers     │
│              (runs on M4 Max master node)                       │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│              PostgreSQL (single master, M4 Max)                 │
│   - canonical state                                             │
│   - job queue (FOR UPDATE SKIP LOCKED)                          │
│   - brand memory, package store, signal store                   │
└────────────────────────────────────────────────────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       ┌──────────┐    ┌──────────┐    ┌──────────┐
       │  Node    │    │  Node    │    │  Node    │
       │ workers  │    │ workers  │    │ workers  │
       │ M3 Ultra │    │ M3 Ultra │    │ Mac Mini │
       │  512GB   │    │   96GB   │    │    M4    │
       └──────────┘    └──────────┘    └──────────┘
              │               │               │
              ▼               ▼               ▼
       ┌────────────────────────────────────────────┐
       │  Local services + subprocess targets:      │
       │  - LM Studio (Qwen3 32B / 235B) via HTTP   │
       │  - ffmpeg (Node spawn)                     │
       │  - yt-dlp (Node spawn)                     │
       │  - Python ML CLIs (Node spawn, see §5.7):  │
       │      ml/transcribe.py    (MLX Whisper)     │
       │      ml/describe_frames.py (mlx-vlm)       │
       │      ml/ocr.py           (Apple Vision)    │
       │      ml/diarize.py       (pyannote)        │
       │  - DojoClaw local HTTP API                 │
       └────────────────────────────────────────────┘
                              │
                              ▼ (only for social dispatch)
                      ┌───────────────┐
                      │ Zernio Cloud  │
                      │  REST API     │
                      └───────────────┘
```

**Why this shape and not something else.**

- **PostgreSQL, not Convex.** Convex was a candidate because Grimfaste v4 runs on it, but Convex requires either Convex Cloud (cloud SaaS, violates the constraint) or Convex self-hosted (immature, adds a fourth concurrency model to learn). DojoClaw already proved the `SELECT FOR UPDATE SKIP LOCKED` pattern on Postgres works for this workload class. Reusing it removes a category of new infrastructure.
- **Next.js + TypeScript end-to-end for orchestration; thin Python CLIs for MLX-bound ML.** TypeScript matches the operator's existing Grimfaste/Convex idioms and gives one language across UI, API, and workers. The four ML steps that MUST stay in Python (MLX Whisper, mlx-vlm Qwen2.5-VL, Apple Vision OCR via pyobjc, pyannote diarization) are isolated to single-file CLI scripts under `ml/` invoked via `child_process.spawn`. Node side parses JSON status from stdout; large outputs (transcripts, scene logs, frame indices) go to disk. The seam is documented in §5.6.
- **One Postgres master, not a cluster.** The dataset is small (thousands of packages per year, not millions). Worker concurrency is the bottleneck, not database throughput.
- **HTTP between ChannelHelm and DojoClaw.** Not direct DB access, even though both sit on the same Mac. Treating DojoClaw as a service forces a clean contract and means DojoClaw can move to a different machine later without a refactor.

---

## 2. The Publishing Package

The Publishing Package is the single canonical object ChannelHelm produces. Everything in the system either creates it, mutates it, approves it, or dispatches portions of it. Its schema is the most important contract in this document.

A Package is **owned by a Brand**, **derives from a Source**, **contains many Assets**, **passes through Approvals**, **emits Dispatches** to DojoClaw and Zernio, and **accumulates Signals** from downstream analytics.

### 2.1 Package object shape

Stored in Postgres as a row in `packages` plus child rows in `assets`, but the logical shape is:

```python
Package = {
    "id": "pkg_01HXYZ...",                  # ULID
    "brand_id": "brd_01HXYZ...",            # FK to brands
    "source_id": "src_01HXYZ...",           # FK to sources
    "status": "draft" | "ingested"
            | "transcribing" | "analyzing_visual"   # may coexist; both must complete
            | "fused" | "analyzed"
            | "ready_for_review" | "approved"
            | "dispatching" | "dispatched"
            | "partially_dispatched" | "failed",
    "created_at": "2026-05-18T10:00:00Z",
    "updated_at": "2026-05-18T10:42:13Z",
    "approved_at": null | "2026-05-18T10:50:00Z",
    "approved_by": null | "thorsten",

    # The source intelligence — produced by the four-layer pipeline (see §5)
    "intelligence": {
        "language": "en",
        "duration_seconds": 2847,
        "speaker_count": 1,                    # detected by pyannote VAD

        # Layer 1 output (audio)
        "transcript_path": "/var/channelhelm/media/src_01HXYZ.../transcript.vtt",
        "diarized_transcript_path": null,      # populated when speaker_count > 1

        # Layer 2 output (visual)
        "scene_cuts": [0.0, 12.4, 38.1, 67.8, ...],   # ffmpeg/PySceneDetect timestamps
        "frame_index_path": "/var/channelhelm/media/src_01HXYZ.../frames/index.json",
        "ocr_path": "/var/channelhelm/media/src_01HXYZ.../ocr.json",

        # Layer 3 + 4 output (fused scene log + LLM-derived signals)
        "scene_log_path": "/var/channelhelm/media/src_01HXYZ.../scene_log.json",
        "topics": ["agentic AI", "SaaS disruption", "post-labor economics"],
        "entities": ["Anthropic", "Claude", "Salesforce"],
        "hooks": [
            {"start": 12.4, "end": 38.1, "score": 0.92,
             "reason": "strong opening claim + rhetorical question + leaning forward, direct eye contact",
             "modalities": ["audio", "visual"]},
            ...
        ],
        "retention_predictions": [
            {"start": 0.0, "end": 30.0, "predicted_retention": 0.84,
             "drivers": ["fast_pace", "hook_word_density"]},
            ...
        ],
        "summary_short": "...",     # 1 sentence
        "summary_medium": "...",    # 1 paragraph
        "summary_long": "..."       # 3-5 paragraphs
    },

    # The derivative assets — each is its own row in `assets`
    "assets": [
        # YouTube optimization bundle
        {"type": "youtube_title_set", ...},
        {"type": "youtube_description", ...},
        {"type": "youtube_chapters", ...},
        {"type": "youtube_tags", ...},
        {"type": "youtube_pinned_comment", ...},
        {"type": "thumbnail_concept", ...},

        # Video derivatives — plans are produced by analyze_intelligence,
        # rendered_* assets are produced by clip_render worker downstream
        {"type": "short_clip_plan", ...},        # cut points + caption + hook (not dispatchable)
        {"type": "rendered_short_clip", ...},    # ffmpeg-rendered vertical MP4 (dispatchable to Zernio)
        {"type": "long_clip_plan", ...},
        {"type": "rendered_long_clip", ...},     # ffmpeg-rendered horizontal MP4 (dispatchable to Zernio)

        # Per-platform text
        {"type": "linkedin_post", ...},
        {"type": "x_post", ...},
        {"type": "x_thread", ...},
        {"type": "tiktok_caption", ...},
        {"type": "reels_caption", ...},
        {"type": "instagram_caption", ...},

        # Editorial (handed to DojoClaw)
        {"type": "article_brief", ...},
        {"type": "newsletter_summary", ...},

        # Calendar
        {"type": "publishing_schedule", ...}
    ],

    # Routing decisions — which downstream system handles what
    # Note: *_plan assets are never dispatched. They are consumed by the clip_render
    # worker to produce rendered_* assets, which are the dispatchable artifacts.
    "routing": {
        "dojoclaw": ["article_brief", "newsletter_summary"],
        "zernio":   ["linkedin_post", "x_post", "x_thread",
                     "tiktok_caption", "reels_caption", "instagram_caption",
                     "rendered_short_clip", "rendered_long_clip"],
        "internal": ["short_clip_plan", "long_clip_plan"],   # consumed by clip_render
        "manual":   ["youtube_title_set", "youtube_description",
                     "youtube_chapters", "youtube_tags",
                     "youtube_pinned_comment", "thumbnail_concept"]
    }
}
```

### 2.2 Asset shape (uniform across types)

Every Asset, regardless of type, has the same wrapper:

```python
Asset = {
    "id": "ast_01HXYZ...",
    "package_id": "pkg_01HXYZ...",
    "type": "linkedin_post",          # discriminator
    "status": "draft" | "approved" | "rejected"
            | "dispatched" | "published" | "failed",
    "approval_required": True,
    "created_at": "...",
    "updated_at": "...",

    # The payload — schema differs per type
    "payload": { ... },

    # Generation provenance — applies uniformly to every artifact produced anywhere
    # in the pipeline (LLM-generated text, Whisper transcripts, VLM frame descriptions,
    # OCR results, scene log, rendered clips). Fields:
    #
    #   provider       — which system produced this. Examples:
    #                      "lm-studio" | "openclaw" | "anthropic-api" |
    #                      "mlx-whisper" | "whisperx" | "mlx-vlm" |
    #                      "apple-vision" | "ffmpeg" | "pil" | "playwright"
    #   model          — specific model or tool version. Examples:
    #                      "qwen3-32b-mlx-8bit" | "qwen3-235b-a22b-mlx-6bit" |
    #                      "qwen2.5-vl-32b" | "whisper-large-v3" |
    #                      "ffmpeg-6.1" | "vision-3.0"
    #   host           — where it ran (LAN hostname:port or "local"). Examples:
    #                      "m3ultra-512gb.local:1234" |
    #                      "192.168.0.156:18789" | "m4max.local"
    #   prompt_version — versioned prompt identifier, null for non-LLM work.
    #                      Example: "linkedin_post.v3"
    #   input_refs     — what this artifact was produced from (provenance chain).
    #                      Examples:
    #                        ["scene_log:src_01HXYZ..."]
    #                        ["asset:ast_01HXYZ..."]      # for clip_render
    #                        ["transcript:src_01HXYZ..."]
    #                        ["frames:src_01HXYZ.../12400ms"]
    #   generated_at   — ISO timestamp
    #
    # LLM-only optional fields:
    #   input_tokens, output_tokens, profile (fast_audio_only | standard_audio_visual | premium_multimodal)
    "provenance": {
        "provider": "lm-studio",
        "model": "qwen3-32b-mlx-8bit",
        "host": "m3ultra-96gb.local:1234",
        "prompt_version": "linkedin_post.v3",
        "input_refs": ["scene_log:src_01HXYZ..."],
        "generated_at": "2026-05-18T10:32:11Z",
        "input_tokens": 4821,
        "output_tokens": 312,
        "profile": "standard_audio_visual"
    },

    # Dispatch state — populated after routing
    "dispatch": {
        "target": "zernio" | "dojoclaw" | "manual" | null,
        "external_id": null | "zernio_post_abc123",
        "dispatched_at": null | "...",
        "result": null | { ... }
    },

    # Signal data — populated by feedback workers
    "signals": {
        "impressions": null | 1240,
        "engagement": null | 87,
        "ctr": null | 0.034,
        "last_sampled_at": null | "..."
    }
}
```

This wrapper is non-negotiable: it is what makes Helm Signal possible. Every asset can be traced to the exact model, prompt version, and source moment that produced it, which is the substrate the feedback loop learns from.

### 2.3 Per-asset payload schemas

```python
# youtube_title_set
# Implemented shape (v1.4): each title carries an integer `score` 0-100
# (click-through potential), array ordered best-first. The UI tolerates the
# legacy `string[]` shape from pre-scoring rows (treated as score=null).
{"titles": [
    {"text": "...", "score": 95},
    ...  # exactly 5 options, best-first
]}

# youtube_description
{"text": "...", "length": 1840, "primary_keyword": "agentic AI"}

# youtube_chapters
{"chapters": [
    {"timestamp": "0:00", "title": "Cold open"},
    {"timestamp": "1:23", "title": "Why SaaS is broken"},
    ...
]}

# youtube_tags
# Implemented shape (v1.4): each tag carries an integer `score` 0-100
# (search relevance), ordered best-first. UI tolerates legacy `string[]`.
{"tags": [
    {"text": "agentic ai", "score": 100},
    {"text": "saas disruption", "score": 92},
    ...
]}

# youtube_pinned_comment
{"text": "..."}

# thumbnail_concept — ONE asset per variant (not a wrapped array).
# Two production paths, distinguished by `generated` + `variant` + provenance.provider:
#
# (a) AI image generation (provenance.provider = "runware" etc.; generated = true).
#     Emitted as a plain image PLUS, when a headline exists, a headline-overlay
#     variant (text composited via ffmpeg drawtext). The operator picks one.
{"rank": 1,
 "variant": "plain",                       # "plain" | "headline"
 "local_path": "/var/.../thumbs/concept_01.jpg",
 "public_url": null,
 "headline": "SILENT AI RIG",              # null on the plain variant
 "visual_prompt": "...",                   # the LLM-built image prompt
 "generated": true,
 "cost_usd": 0.0013}                        # counted once on the plain variant
#
# (b) ffmpeg frame-extraction fallback when no image provider is configured
#     (provenance.provider = "ffmpeg"; generated = false). One asset per hook.
{"rank": 1,
 "variant": "frame",
 "timestamp": 47.2,
 "local_path": "/var/.../thumbs/concept_01.jpg",
 "public_url": null,
 "hook_reason": "...",
 "hook_score": 0.92,
 "generated": false}

# short_clip_plan — blueprint asset, NOT dispatchable.
# Consumed by the clip_render worker, which produces one rendered_short_clip per entry.
{"clips": [
    {"clip_index": 0,
     "start": 12.4, "end": 67.8, "caption": "...",
     "hook_score": 0.92, "platforms": ["tiktok", "reels", "shorts"],
     "vertical_crop": {"focus_x": 0.4, "focus_y": 0.5},
     "burn_in_subtitles": true,
     "music_bed": null},
    ...
]}

# rendered_short_clip — produced by clip_render. Dispatchable to Zernio.
# One asset per clip entry in the parent short_clip_plan.
{"plan_asset_id": "ast_01HXYZ...",       # the short_clip_plan that produced this
 "clip_index": 0,
 "local_path": "/var/channelhelm/media/{src_id}/clips/short_00.mp4",
 "public_url": null,                      # populated when served via Cloudflare Tunnel
 "duration_seconds": 55.4,
 "width": 1080, "height": 1920,
 "caption": "...",                        # carried from plan
 "hashtags": [...],
 "platforms": ["tiktok", "reels", "shorts"]}

# long_clip_plan — blueprint asset, NOT dispatchable. Consumed by clip_render.
{"clips": [
    {"clip_index": 0,
     "start": 240.0, "end": 420.0, "caption": "...",
     "hook_score": 0.84, "platforms": ["youtube", "linkedin"],
     "horizontal_crop": null,
     "burn_in_subtitles": false},
    ...
]}

# rendered_long_clip — produced by clip_render. Dispatchable to Zernio.
{"plan_asset_id": "ast_01HXYZ...",
 "clip_index": 0,
 "local_path": "/var/channelhelm/media/{src_id}/clips/long_00.mp4",
 "public_url": null,
 "duration_seconds": 180.0,
 "width": 1920, "height": 1080,
 "caption": "...",
 "platforms": ["youtube", "linkedin"]}

# linkedin_post
{"text": "...",
 "media_refs": ["ast_rendered_short_clip_01HXYZ..."],   # rendered_* asset ID only
 "first_comment": "..."}

# x_post
{"text": "...", "length": 247, "media_refs": [...]}

# x_thread
{"tweets": [{"text": "...", "media_refs": [...]}, ...]}

# facebook_post / threads_post / bluesky_post / reddit_post / pinterest_pin /
#   telegram_post / discord_message / google_business_post  (added 2026)
# Extended-network text posts, each dispatched to its Zernio network (see
# NETWORK_BY_TYPE in workers/integrations/zernio.ts). GATED GENERATION: unlike
# the always-on core social types, these are generated ONLY when the brand has
# the matching account connected (brands.zernio_accounts[network]) — drafting a
# post for a network the brand can't publish to is waste. Per-network length and
# tone live in each prompts/<type>.v1.md. Dispatch reads payload.text.
{"text": "..."}

# tiktok_caption / reels_caption / instagram_caption
# Caption-only assets — NOT generated in v1 (deferred; the clip-centric model
# carries per-clip captions on short_clip_plan instead). The actual media is in
# a rendered_short_clip referenced via media_refs. If generated later, dispatch
# combines caption + rendered clip into one Zernio post.
{"text": "...", "hashtags": [...], "media_refs": ["ast_rendered_short_clip_..."]}

# article_brief — handed to DojoClaw, see Section 8
{"target_brand": "thorstenmeyerai",
 "working_title": "...",
 "angle": "...",
 "primary_keyword": "...",
 "secondary_keywords": [...],
 "target_word_count": 1800,
 "target_audience": "...",
 "voice_profile_ref": "...",
 "key_points": [...],
 "quotes_from_source": [...],
 "must_link_to": [...],
 "syndication_targets": [...]}

# newsletter_summary
{"subject_options": [...], "preheader": "...", "body_html": "...",
 "body_markdown": "...", "cta": {...}}

# publishing_schedule
{"slots": [
    {"asset_id": "ast_01HXYZ...", "platform": "linkedin",
     "scheduled_for": "2026-05-19T14:00:00Z", "reasoning": "..."},
    ...
]}
```

---

## 3. Multi-brand scoping

Multi-brand is the root of the data model, not a tag on packages. With 477 sites and multiple distinct brand voices, a single-tenant assumption would break the system within days. Every entity below `brand` is brand-scoped. No cross-brand reads happen except in admin views.

### 3.1 Brand object

```python
Brand = {
    "id": "brd_01HXYZ...",
    "slug": "thorstenmeyerai",
    "name": "Thorsten Meyer AI",
    "active": True,

    # Editorial voice — used by DojoClaw and the social asset generators
    "voice_profile": {
        "tone": "direct, data-grounded, skeptical of vendor framing",
        "style_notes": "edits by subtraction, no hedge words, ...",
        "avoid": ["synergy", "leverage as verb", "in today's world"],
        "example_passages": [...]   # few-shot anchor texts
    },

    # Brand → Zernio Profile mapping (1:1)
    "zernio_profile_id": "prof_abc123",

    # Brand → DojoClaw site/category mapping (1:N)
    "dojoclaw_sites": [
        {"site_id": "thorstenmeyerai.com",
         "default_category": "ai",
         "default_author": "thorsten-meyer"}
    ],

    # Platform defaults
    "youtube_channel_id": "UCxxxx",
    "default_publishing_schedule": "balanced" | "burst" | "queue",

    # Processing profile — controls which pipeline layers run for this brand.
    # See §5.5 for profile definitions.
    "default_processing_profile": "standard_audio_visual",

    # Approval policy. Note: *_plan asset types are never dispatchable and
    # therefore must not appear here. Only rendered_* and text/editorial assets
    # are candidates for auto_dispatch_for.
    "approval_required_for": ["article_brief", "x_post", "linkedin_post"],
    "auto_dispatch_for": []                  # empty by default; opt in per type
}
```

### 3.2 Brand-to-downstream mapping rules

- **One Brand maps to exactly one Zernio Profile.** Zernio's Profile concept already exists for this purpose and groups social Accounts together. ChannelHelm creates the Profile via Zernio's API when a Brand is created, then stores `zernio_profile_id` on the Brand.
- **One Brand can map to multiple DojoClaw sites.** A single brand might publish to its primary site plus syndicate to a partner site. The Brand object holds the list; `article_brief` assets specify `target_brand` plus optional `syndication_targets`.

---

## 4. PostgreSQL schema

The full schema for v1. SQL is real and runnable. ULIDs are stored as `TEXT` for readability over `UUID` because hand-debugging on a local-first system matters.

```sql
-- ─── Brands ────────────────────────────────────────────────────────

CREATE TABLE brands (
    id TEXT PRIMARY KEY,                       -- brd_...
    slug TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    voice_profile JSONB NOT NULL DEFAULT '{}'::jsonb,
    zernio_profile_id TEXT,
    dojoclaw_sites JSONB NOT NULL DEFAULT '[]'::jsonb,
    youtube_channel_id TEXT,
    default_publishing_schedule TEXT NOT NULL DEFAULT 'balanced',
    default_processing_profile TEXT NOT NULL DEFAULT 'standard_audio_visual',
    approval_required_for JSONB NOT NULL DEFAULT '[]'::jsonb,
    auto_dispatch_for JSONB NOT NULL DEFAULT '[]'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_brands_active ON brands(active) WHERE active = TRUE;

-- ─── Sources (input artifacts) ────────────────────────────────────

CREATE TABLE sources (
    id TEXT PRIMARY KEY,                       -- src_...
    brand_id TEXT NOT NULL REFERENCES brands(id),
    kind TEXT NOT NULL,                        -- youtube_url | uploaded_video | podcast | transcript_only
    origin_url TEXT,                           -- YouTube URL if applicable
    local_media_path TEXT,                     -- /var/channelhelm/media/...
    duration_seconds INTEGER,
    language TEXT,
    title TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sources_brand ON sources(brand_id);
CREATE INDEX idx_sources_kind ON sources(kind);

-- ─── Packages ─────────────────────────────────────────────────────

CREATE TABLE packages (
    id TEXT PRIMARY KEY,                       -- pkg_...
    brand_id TEXT NOT NULL REFERENCES brands(id),
    source_id TEXT NOT NULL REFERENCES sources(id),
    status TEXT NOT NULL DEFAULT 'draft',
    processing_profile TEXT NOT NULL DEFAULT 'standard_audio_visual',   -- see §5.6
    intelligence JSONB NOT NULL DEFAULT '{}'::jsonb,
    routing JSONB NOT NULL DEFAULT '{}'::jsonb,
    approved_at TIMESTAMPTZ,
    approved_by TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_packages_brand_status ON packages(brand_id, status);
CREATE INDEX idx_packages_source ON packages(source_id);
CREATE INDEX idx_packages_updated ON packages(updated_at DESC);

-- ─── Assets (one row per derivative) ──────────────────────────────

CREATE TABLE assets (
    id TEXT PRIMARY KEY,                       -- ast_...
    package_id TEXT NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
    brand_id TEXT NOT NULL REFERENCES brands(id),   -- denormalized for fast brand-scoped queries
    type TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    approval_required BOOLEAN NOT NULL DEFAULT TRUE,
    payload JSONB NOT NULL,
    provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
    dispatch JSONB NOT NULL DEFAULT '{}'::jsonb,
    signals JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_assets_package ON assets(package_id);
CREATE INDEX idx_assets_brand_type_status ON assets(brand_id, type, status);
CREATE INDEX idx_assets_dispatch_external
    ON assets((dispatch->>'external_id'))
    WHERE dispatch->>'external_id' IS NOT NULL;

-- ─── Job queue (the worker substrate) ─────────────────────────────

CREATE TABLE jobs (
    id BIGSERIAL PRIMARY KEY,
    kind TEXT NOT NULL,                        -- ingest | transcribe_audio | analyze_visual | fuse | analyze_intelligence | generate_asset | clip_render | dispatch | collect_signal
    payload JSONB NOT NULL,                    -- {package_id, asset_id, ...}
    status TEXT NOT NULL DEFAULT 'pending',    -- pending | running | done | failed
    priority INTEGER NOT NULL DEFAULT 5,       -- lower = sooner
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    locked_by TEXT,                            -- worker hostname
    locked_at TIMESTAMPTZ,
    run_after TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error TEXT,
    idempotency_key TEXT,                      -- per-kind uniqueness; NULL allowed for non-idempotent jobs
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Idempotency: at most one live or completed job per (kind, idempotency_key).
-- NULLs ignored so jobs without keys (e.g. ad-hoc backfills) are unconstrained.
CREATE UNIQUE INDEX idx_jobs_kind_idempotency
    ON jobs(kind, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

-- Idempotency-key conventions (enqueuers MUST set these):
--   ingest                 → 'ingest:{source_id}'
--   transcribe_audio       → 'transcribe_audio:{source_id}'
--   analyze_visual         → 'analyze_visual:{source_id}:{profile}'
--   fuse                   → 'fuse:{source_id}:{profile}'
--   analyze_intelligence   → 'analyze_intelligence:{source_id}:{profile}'
--   generate_asset         → 'generate_asset:{package_id}:{asset_type}'
--   clip_render            → 'clip_render:{plan_asset_id}:{clip_index}'
--   dispatch               → 'dispatch:{asset_id}'  (re-dispatch requires explicit
--                                                    delete-then-insert of the job row)
--   collect_signal         → 'collect_signal:{asset_id}:{window_start_iso}'
--
-- Re-running a step intentionally (e.g. regenerate an asset with a new prompt
-- version) requires bumping the key — generate_asset uses asset_type, so a
-- regeneration creates a NEW asset row with a fresh ID rather than overwriting.

CREATE INDEX idx_jobs_claim
    ON jobs(status, priority, run_after)
    WHERE status = 'pending';

CREATE INDEX idx_jobs_kind_status ON jobs(kind, status);

-- ─── Dispatches (audit log of every external call) ────────────────

CREATE TABLE dispatches (
    id BIGSERIAL PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id),
    target TEXT NOT NULL,                      -- zernio | dojoclaw
    request_payload JSONB NOT NULL,
    response_payload JSONB,
    external_id TEXT,
    success BOOLEAN,
    error TEXT,
    dispatched_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_dispatches_asset ON dispatches(asset_id);
CREATE INDEX idx_dispatches_target_success ON dispatches(target, success);

-- ─── Webhooks (inbound from Zernio + DojoClaw) ────────────────────

CREATE TABLE webhook_events (
    id BIGSERIAL PRIMARY KEY,
    source TEXT NOT NULL,                      -- zernio | dojoclaw
    source_event_id TEXT NOT NULL,             -- the sender's event ID (e.g. Zernio's event "_id" or DojoClaw's job_id+event)
    event_type TEXT NOT NULL,                  -- post.published | post.failed | article.completed
    external_id TEXT,                          -- the resource ID on the source (e.g. zernio post _id)
    payload JSONB NOT NULL,
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ
);

-- Idempotency on inbound webhooks. Zernio and DojoClaw may redeliver. A redelivered
-- event hits the unique constraint at INSERT time, the receiver swallows the
-- duplicate-key error with HTTP 200, and no duplicate processing occurs.
CREATE UNIQUE INDEX idx_webhook_source_event
    ON webhook_events(source, source_event_id);

CREATE INDEX idx_webhook_unprocessed
    ON webhook_events(source, received_at)
    WHERE processed = FALSE;

-- If a webhook arrives without a source-provided event ID (older Zernio events,
-- ad-hoc DojoClaw pushes), the receiver generates a stable one by hashing
-- (event_type, external_id, timestamp_floor_to_minute) before insert.

-- ─── Signals (Helm Signal — the feedback loop substrate) ──────────

CREATE TABLE signals (
    id BIGSERIAL PRIMARY KEY,
    brand_id TEXT NOT NULL REFERENCES brands(id),
    asset_id TEXT REFERENCES assets(id),
    source_signal TEXT NOT NULL,               -- zernio | dojoclaw | youtube
    metric TEXT NOT NULL,                      -- impressions | engagement | ctr | reads | ranking
    value DOUBLE PRECISION NOT NULL,
    sampled_at TIMESTAMPTZ NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_signals_brand_asset ON signals(brand_id, asset_id);
CREATE INDEX idx_signals_sampled ON signals(sampled_at DESC);

-- ─── Voice profile examples (Brand memory) ────────────────────────

CREATE TABLE voice_examples (
    id BIGSERIAL PRIMARY KEY,
    brand_id TEXT NOT NULL REFERENCES brands(id),
    asset_type TEXT NOT NULL,                  -- linkedin_post | x_post | article_brief | ...
    text TEXT NOT NULL,
    performance_score DOUBLE PRECISION,        -- normalized 0-1, populated by Helm Signal
    used_as_example_count INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_voice_examples_brand_type_score
    ON voice_examples(brand_id, asset_type, performance_score DESC);

-- ─── A/B experiments (Helm Signal; added in v1.5) ─────────────────
-- Self-run title/thumbnail rotation on a PUBLISHED YouTube video. The
-- experiment_tick worker applies one variant at a time (videos.update title +
-- thumbnails.set), waits rotation_hours, reads the variant's performance from
-- the YouTube Analytics API (yt-analytics.readonly scope), then decides a
-- winner on `metric` once every variant has run `rounds` rotations and cleared
-- `min_views`. The winner is applied permanently and fed into voice_examples.
-- Native YouTube "Test & Compare" is NOT in the Data API — hence self-run.

CREATE TABLE experiments (
    id TEXT PRIMARY KEY,                          -- exp_<ulid>
    brand_id TEXT NOT NULL REFERENCES brands(id),
    package_id TEXT NOT NULL REFERENCES packages(id),
    video_id TEXT NOT NULL,                       -- published YouTube video (rotation target)
    kind TEXT NOT NULL,                           -- title | thumbnail | title_thumbnail
    status TEXT NOT NULL DEFAULT 'draft',         -- draft | running | decided | cancelled | error
    metric TEXT NOT NULL DEFAULT 'views',         -- views | impression_ctr | estimated_minutes_watched
    variants JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{variant_index,label,title?,thumbnail_path?,observations[]}]
    rotation_hours INTEGER NOT NULL DEFAULT 48,   -- how long each variant stays live per cycle
    min_views INTEGER NOT NULL DEFAULT 50,        -- guardrail: each variant must clear this before deciding
    rounds INTEGER NOT NULL DEFAULT 1,            -- full rotations before a decision is allowed
    current_variant INTEGER,                      -- index currently applied to the video
    current_cycle INTEGER NOT NULL DEFAULT 0,
    current_variant_since TIMESTAMPTZ,
    winner_variant INTEGER,
    last_error TEXT,
    started_at TIMESTAMPTZ,
    decided_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_experiments_brand_status ON experiments(brand_id, status);
CREATE INDEX idx_experiments_running      ON experiments(status) WHERE status = 'running';
CREATE INDEX idx_experiments_package      ON experiments(package_id);

-- ─── LLM + image providers (configurable; added after v1.3) ────────
-- The provider system postdates the original §4 schema. ONE table holds both
-- chat/LLM providers (category='text', the default) and text-to-image providers
-- (category='image', e.g. Runware for AI thumbnails). getProvider() and
-- getImageProvider() filter by category so the two selection paths never cross.
-- Edited at /providers (NOT a runtime setting — multi-row + structured; see §
-- "LLM providers are explicitly NOT a setting"). API keys are encrypted at rest
-- (secret-box, AES-256-GCM). When the table is empty the worker auto-seeds an
-- LM Studio text row from LM_STUDIO_*/OPENCLAW_BASE_URL env, preserving the
-- original env-only behavior with zero config.

CREATE TABLE llm_providers (
    id BIGSERIAL PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'text',      -- 'text' (chat/LLM) | 'image' (text-to-image)
    type TEXT NOT NULL DEFAULT 'openai-compatible',
                                                --   text:  openai-compatible | anthropic | codex-cli
                                                --   image: runware
    base_url TEXT NOT NULL,
    api_key TEXT NOT NULL DEFAULT '',           -- encrypted at rest (AES-256-GCM)
    model TEXT NOT NULL,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    purpose TEXT NOT NULL DEFAULT 'all',        -- 'all' | a processing profile (per-purpose routing)
    max_concurrent INTEGER NOT NULL DEFAULT 0,  -- v1.5: 0 = unlimited; caps in-flight requests per provider (semaphore in the resolver)
    max_tokens INTEGER NOT NULL DEFAULT 2048,
    temperature DOUBLE PRECISION NOT NULL DEFAULT 0.5,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_llm_providers_enabled  ON llm_providers(enabled) WHERE enabled = TRUE;
CREATE INDEX idx_llm_providers_purpose  ON llm_providers(purpose);
CREATE INDEX idx_llm_providers_category ON llm_providers(category);
```

---

## 5. Video understanding pipeline

The "understanding" that produces a Publishing Package is a four-layer pipeline, not a single transcription step. Whisper alone gives you words; the assets that win on social — the right clip cut-points, the right thumbnail moments, the hook timestamps — depend on what's visible on screen as much as what's said. This section locks the pipeline.

### 5.1 The four layers

**Layer 1 — Audio.** Local Whisper transcription with word-level timestamps. Implementation: **MLX Whisper large-v3** on M-series silicon, called from the `transcribe_audio` worker. Output: VTT with word-level timestamps at `/var/channelhelm/media/{src_id}/transcript.vtt`. When the source has multiple speakers (detected via a cheap pyannote VAD pre-pass), the worker additionally runs **WhisperX** to fuse transcription with pyannote diarization, producing a diarized transcript with `[speaker_NN, start, end, text]` tuples at `/var/channelhelm/media/{src_id}/transcript_diarized.json`.

**Layer 2 — Visual.** Three parallel sub-steps in the `analyze_visual` worker:

- **Scene detection** via `ffmpeg`'s scene filter (threshold 0.3) or PySceneDetect's content detector. Output: list of cut-point timestamps stored in the `intelligence.scene_cuts` array.
- **Frame sampling**: 1 fps baseline plus every scene boundary. Frames written to `/var/channelhelm/media/{src_id}/frames/{timestamp_ms}.jpg`, indexed in `frames/index.json`.
- **On-screen text via OCR** using Apple's **Vision framework** (`VNRecognizeTextRequest`), called from Python via `pyobjc`. Runs on the Neural Engine, faster than Tesseract on M-series, free, native. Output: list of `{timestamp, bounding_box, text, confidence}` records at `ocr.json`.

**Layer 3 — Visual-language understanding.** Sampled frames go to a vision-language model that describes what is on screen. Implementation: **Qwen2.5-VL 32B** running via MLX on the M3 Ultra 512GB. Each frame is prompted for a 1-2 sentence visual description focused on facially expressive moments, gestures, slides/charts, and demo content. Output gets merged into the frame index as `frames[i].description`.

**Layer 4 — Fusion and intelligence.** The `fuse` worker merges the three streams into a single **scene log** aligned to ~5-10 second windows. Then the `analyze_intelligence` worker calls Qwen3 32B (or 235B for premium passes) over the scene log to produce topics, entities, hooks, retention predictions, and summaries. The LLM never sees raw transcript alone — it always reasons over the fused scene log.

### 5.2 The scene log schema

The scene log is the central intermediate artifact between the raw streams and the LLM. It is what makes ChannelHelm's intelligence multi-modal. Stored as JSON at `scene_log.json`:

```python
SceneLog = {
    "source_id": "src_01HXYZ...",
    "windows": [
        {
            "start": 12.4,
            "end": 18.7,
            "speaker": "speaker_01",                    # null when undiarized
            "text": "the whole industry is wrong about agents",
            "text_word_count": 8,
            "visual_descriptions": [
                {"timestamp": 13.0,
                 "description": "speaker at desk, leaning forward, direct eye contact with camera"},
                {"timestamp": 17.0,
                 "description": "same framing, speaker gesturing with right hand"}
            ],
            "on_screen_text": [],                       # OCR results within window
            "audio_features": {
                "speech_rate_wpm": 178,                 # vs document baseline
                "speech_rate_delta": "+22%",            # vs prior window
                "emphasis_words": ["wrong"],            # prosodic stress detected
                "pause_after_seconds": 1.2,
                "energy_db": -14.2
            },
            "scene_boundary_within_window": false
        },
        ...
    ],
    "global_features": {
        "total_speakers": 1,
        "total_scene_cuts": 14,
        "average_speech_rate_wpm": 156,
        "screen_text_density": "low"                    # low|medium|high
    }
}
```

The LLM prompt for `analyze_intelligence` reasons over this structure to identify hooks (windows where audio AND visual signals converge), select clip candidates (contiguous windows with hook scores above threshold), and predict retention (windows with high speech-rate variance + emphasis density + visual change).

### 5.3 Retention prediction without YouTube Studio

For Thorsten's own YouTube channel, real retention curves can be pulled from YouTube Studio's API and stored as ground truth in the `signals` table. For everything else — uploaded video, podcasts, webinars, other people's content used for Backlog Revival — retention is predicted from scene log features. The predictors are:

- Pace deltas (speech_rate_delta against rolling baseline)
- Emphasis density (emphasis_words per window normalized by word count)
- Rhetorical structure (LLM-tagged: questions, claims, lists, callbacks)
- Visual change rate (scene_boundary_within_window flags + visual description deltas)
- Hook word patterns ("I was wrong", "here's the thing", "the real reason", learned from voice_examples)
- Speaker behavior (gesture intensity, expression descriptors from VLM)

This is not a trained model in v1. It is an LLM call over the scene log with an explicit prompt that scores each window 0-1 for predicted retention with reasoning. Over time, when YouTube Studio retention data is available, those scores become training signal for a small calibration model (v1.5).

### 5.4 Performance budget on the existing fleet

On a typical 30-minute solo-speaker video:

| Stage              | Tool                        | Mac                | Wall time     |
|--------------------|-----------------------------|--------------------|---------------|
| Ingest             | yt-dlp + ffmpeg audio split | M4 Max             | ~30 s         |
| Transcribe audio   | MLX Whisper large-v3        | M3 Ultra 96GB      | ~60 s         |
| Diarize (if multi) | WhisperX + pyannote         | M3 Ultra 96GB      | +90 s         |
| Scene detect       | ffmpeg scene filter         | M4 Max             | ~20 s         |
| Frame sample + OCR | ffmpeg + Apple Vision       | M4 Max             | ~45 s         |
| VLM frame desc     | Qwen2.5-VL 32B MLX          | M3 Ultra 512GB     | ~3-5 min      |
| Fuse               | Python merge                | any                | ~5 s          |
| Intelligence       | Qwen3 32B MLX               | M3 Ultra 96GB      | ~60 s         |
| **Total (parallel)** |                           |                    | **~5-7 min**  |

The VLM step is the bottleneck. Two knobs to turn if it gets tight: drop frame sampling rate to 0.5 fps (still captures scene boundaries), or swap Qwen2.5-VL 32B for Qwen2.5-VL 7B (3x faster, slightly less precise visual descriptions but still well above baseline). For premium passes on hero content, use Qwen2.5-VL 72B at the cost of doubled wall time.

### 5.5 Processing profiles

A profile controls which pipeline layers run and which models are used. Every package is processed under exactly one profile, recorded on `intelligence.profile` and propagated into every generated artifact's `provenance.profile`. The profile is selected per-source at ingest time, defaulting to the brand's `default_processing_profile`. Four profiles are defined (cheapest to richest); `transcription_only` was added in v1.1 to make Backlog Revival inexpensive:

**`transcription_only`** *(v1.1)* — the cheapest profile. Audio transcription only: no visual phase, no diarization, no thumbnail generation. The engine behind Backlog Revival's in-place re-mining of an existing back catalogue under today's prompts.

| Layer            | Runs?    | Model / tool                                  |
|------------------|----------|-----------------------------------------------|
| ingest           | yes      | yt-dlp + ffmpeg audio extract                 |
| transcribe_audio | yes      | MLX Whisper large-v3                          |
| diarize          | **no**   | skipped                                       |
| analyze_visual   | **no**   | skipped                                       |
| fuse             | yes      | audio-only scene log (visual fields empty)    |
| analyze_intelligence | yes  | Qwen3 32B                                     |
| generate_asset   | yes      | all text assets; no thumbnail_concept (audio-only profiles skip thumbnails) |
| Wall time (30 min source)  | ~1-2 min |                                   |

**`fast_audio_only`** — audio-only pipeline for low-stakes throughput or content where visuals don't matter (audio-only podcasts, voice memos, draft passes on hero content for a fast turn).

| Layer            | Runs?    | Model / tool                                  |
|------------------|----------|-----------------------------------------------|
| ingest           | yes      | yt-dlp + ffmpeg audio extract                 |
| transcribe_audio | yes      | MLX Whisper large-v3                          |
| diarize          | yes if speaker_count > 1 | WhisperX + pyannote          |
| analyze_visual   | **no**   | skipped                                       |
| fuse             | yes      | audio-only scene log (visual fields empty)    |
| analyze_intelligence | yes  | Qwen3 32B                                     |
| generate_asset   | yes      | all text assets; `short_clip_plan` produced only as time ranges with no visual rationale, `rendered_short_clip` produced without burned subtitle styling, no thumbnail_concept |
| Wall time (30 min source)  | ~2 min |                                     |

**`standard_audio_visual`** — default profile. Full multi-modal pipeline at routine quality.

| Layer            | Runs?    | Model / tool                                  |
|------------------|----------|-----------------------------------------------|
| ingest           | yes      | yt-dlp + ffmpeg audio extract + scene detect  |
| transcribe_audio | yes      | MLX Whisper large-v3                          |
| diarize          | yes if speaker_count > 1 | WhisperX + pyannote          |
| analyze_visual   | yes      | 1 fps + scene boundaries; Apple Vision OCR; Qwen2.5-VL **7B** descriptions |
| fuse             | yes      | full multi-modal scene log                    |
| analyze_intelligence | yes  | Qwen3 **32B**                                 |
| generate_asset   | yes      | all assets including thumbnail_concept        |
| Wall time (30 min source)  | ~5-7 min |                                 |

**`premium_multimodal`** — hero content. Full pipeline at the highest quality the fleet can sustain.

| Layer            | Runs?    | Model / tool                                  |
|------------------|----------|-----------------------------------------------|
| ingest           | yes      | yt-dlp + ffmpeg audio extract + scene detect  |
| transcribe_audio | yes      | MLX Whisper large-v3                          |
| diarize          | yes always (forces speaker labels even if VAD says 1) | WhisperX + pyannote |
| analyze_visual   | yes      | 1 fps + scene boundaries; Apple Vision OCR; Qwen2.5-VL **32B** descriptions |
| fuse             | yes      | full multi-modal scene log                    |
| analyze_intelligence | yes  | Qwen3 **235B A22B**                           |
| generate_asset   | yes      | all assets, regenerate-on-low-confidence enabled, three thumbnail concepts at three timestamps |
| Wall time (30 min source)  | ~10-14 min |                               |

**Operator selection.** The dashboard's source-creation form exposes the profile as a select with the brand default pre-selected. Operators can change it per package without changing the brand default. The chosen profile is stored on the `packages` row (see Section 4 — add `processing_profile TEXT NOT NULL`) and read by every worker in the chain.

**Why four and not more.** v1 launched with three profiles to keep prompt versions and asset payload shapes tractable; v1.1 added `transcription_only` because Backlog Revival needed cheap re-mining of old videos, and it reuses the existing audio-only path without a new prompt set or voice-example calibration. Further profiles each cost another performance budget to maintain, so the bar for a fifth is high.

### 5.6 Node ↔ Python ML CLI contract

The four MLX-bound steps (transcription, frame description, OCR, diarization) remain in Python because they have no Node equivalent at acceptable speed on Apple Silicon. The rest of the pipeline (orchestration, queue, fusion, intelligence prompts, asset generation, dispatch, signals) is TypeScript. The seam between the two is a small set of CLI scripts under `ml/`.

**Invocation pattern.** Node workers spawn a Python script via `child_process.spawn` with positional or `--flag` arguments. The script writes its primary output to a file path passed in `--output`. The script's stdout is a single JSON line indicating completion status, durations, and any small metadata. Anything verbose goes to stderr for logging.

```ts
// Node side — workers/integrations/ml_subprocess.ts
const { stdout } = await runPythonCli('ml/transcribe.py', {
    '--input':  '/var/channelhelm/media/src_01HXYZ.../audio.wav',
    '--output': '/var/channelhelm/media/src_01HXYZ.../transcript.json',
    '--model':  'mlx-community/whisper-large-v3-mlx',
    '--language': 'auto'
});
const status = JSON.parse(stdout);   // { ok, duration_ms, output_path, ... }
```

```python
# ml/transcribe.py — sketch
import argparse, json, sys, time
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument('--input', required=True)
ap.add_argument('--output', required=True)
ap.add_argument('--model', default='mlx-community/whisper-large-v3-mlx')
ap.add_argument('--language', default='auto')
args = ap.parse_args()

t0 = time.time()
try:
    # ... mlx_whisper.transcribe(...) ...
    Path(args.output).write_text(json.dumps(result))
    print(json.dumps({
        'ok': True,
        'output_path': args.output,
        'duration_ms': int((time.time() - t0) * 1000),
        'model': args.model,
        'language_detected': result['language'],
    }))
    sys.exit(0)
except Exception as e:
    print(json.dumps({'ok': False, 'error': str(e),
                      'duration_ms': int((time.time() - t0) * 1000)}))
    sys.exit(1)
```

**The four scripts in v1.**

| Script                   | Purpose                                          | Backed by                         |
|--------------------------|--------------------------------------------------|-----------------------------------|
| `ml/transcribe.py`       | Audio → transcript.json (word-level timestamps)  | `mlx-whisper` (large-v3)          |
| `ml/diarize.py`          | Audio → speaker turns aligned to transcript      | `pyannote-audio` + WhisperX align |
| `ml/describe_frames.py`  | Frame paths → frame descriptions JSON            | `mlx-vlm` (Qwen2.5-VL 32B or 7B)  |
| `ml/ocr.py`              | Frame paths → on-screen text JSON                | Apple Vision via `pyobjc`         |

Each script lives in a single file. The four files share a `ml/_lib.py` with the arg-parser scaffolding and the stdout JSON envelope. No FastAPI, no Flask, no shared service layer.

**Python dependency isolation.** A single `uv` project at the repo root, with `ml/pyproject.toml` listing only what the four scripts need. The Node side never imports Python and never touches the venv directly — it just invokes `uv run python ml/transcribe.py ...` (or a wrapped `ml/run.sh`). When the user runs `pnpm install`, a postinstall hook calls `uv sync` so Python deps come along with Node deps.

**Provenance writeback.** When the Node worker calls a Python CLI, it constructs the provenance block (§2.2) from the CLI's stdout status response: `provider` is `mlx-whisper`/`mlx-vlm`/`apple-vision`/`pyannote`, `model` is the value the CLI reports back, `host` is the local hostname, `input_refs` is whatever the worker passed in. Provenance is constructed in TypeScript and written to Postgres by the worker, not by Python.

**Why not a Python HTTP service.** Considered (Option B in the v1.3 design discussion). Rejected because: it adds a process to operate, complicates auth, doubles the surface for failure, and offers no real isolation benefit over subprocess invocation on the same Mac. Subprocess spawning is ~50 ms overhead per call, dwarfed by the ML work itself.

**Why not pure Node.** Considered (Option C). Rejected because `whisper.cpp` is ~2-3× slower than MLX Whisper on M-series, there is no MLX-equivalent VLM stack for Node, and Tesseract.js produces meaningfully worse OCR than Apple Vision. The whole reason the fleet has the M3 Ultras is to use MLX speed.

### 5.7 What is deliberately not in this pipeline (yet)

- **Audio event detection** (laughter, music, applause). Useful for podcasts. Add in v1.1 via a YAMNet or AST model — small, runs on Neural Engine.
- **Music/copyright detection** for clips. Important if syndicating to YouTube Shorts. v1.5.
- **Face recognition / speaker identification by name** rather than just `speaker_01`. v2 — requires per-brand face index, more storage, privacy considerations.
- **Sentiment over time curves**. Helpful for emotion-driven clip selection. v1.5, derived from the scene log without extra inference.

---

## 6. The worker queue pattern

### 6.1 Claiming jobs (the SKIP LOCKED idiom)

This is the proven DojoClaw pattern, applied verbatim:

```sql
-- A worker claims one job
WITH next AS (
    SELECT id FROM jobs
    WHERE status = 'pending'
      AND run_after <= now()
    ORDER BY priority ASC, id ASC
    LIMIT 1
    FOR UPDATE SKIP LOCKED
)
UPDATE jobs
   SET status = 'running',
       locked_by = $1,            -- worker hostname like 'macmini-01'
       locked_at = now(),
       attempts = attempts + 1,
       updated_at = now()
  FROM next
 WHERE jobs.id = next.id
RETURNING jobs.*;
```

This is safe across an arbitrary number of workers across multiple Macs with zero coordination beyond the database. No Redis, no broker, no leader election.

**Node implementation.** The TypeScript queue layer (~150 lines) lives at `workers/queue.ts` and exposes `enqueue(kind, payload, idempotencyKey, priority?)`, `claim(workerKinds[], lockedBy)`, `complete(jobId)`, and `fail(jobId, error)`. All four methods use the `pg` driver directly with prepared statements. No ORM in this layer — the queue is hot path and the SQL is verbatim from this section. The queue layer enforces idempotency conventions from §4 and is the ONLY module allowed to INSERT into `jobs`.

### 6.2 Job kinds and their order in the pipeline

```
ingest                  → yt-dlp/upload, ffmpeg audio extract, ffmpeg scene detect
   │
   ├─ fan out (parallel) ───────────────────────────┐
   ▼                                                 ▼
transcribe_audio                                analyze_visual
  MLX Whisper + optional WhisperX                 frame sample + Apple Vision OCR
  (M3 Ultra 96GB)                                 + Qwen2.5-VL descriptions
                                                  (M3 Ultra 512GB)
   │                                                 │
   └─────────────── join ────────────────────────────┘
                    ▼
                fuse              → merge streams into scene_log.json
                    │
                    ▼
              analyze_intelligence → Qwen3 32B/235B → topics, hooks, retention, summaries
                    │
                    ▼
              generate_asset      → one job per asset type, parallelizable
                    │
                    ▼
            [awaiting_approval — no jobs, package sits in this state]
                    │
                    ▼
                dispatch          → fans out per approved asset to DojoClaw or Zernio
                    │
                    ▼
              collect_signal      → recurring job, pulls analytics back into signals table
```

The `transcribe_audio` and `analyze_visual` branches run concurrently. The `fuse` job has a dependency check: it claims only when both upstream jobs for the same `source_id` are `done`. Implementation: `fuse` job is enqueued by whichever of the two upstream jobs finishes last (the worker checks if its sibling is done, and if so enqueues `fuse`).

### 6.3 Worker affinity (which Mac runs which job kinds)

Workers self-select by kind. Each worker is a Node process started by `launchd` per Mac, running a TypeScript entry point via `tsx`. Configuration is a flag passed at start:

```bash
# On the M3 Ultra 512GB (LLM #1, premium model + VLM)
# Python ML CLIs (ml/describe_frames.py) invoked as subprocesses from analyze_visual workers.
pnpm run worker -- --kinds analyze_visual,analyze_intelligence,generate_asset \
                   --llm-host m3ultra-512gb.local:1234 \
                   --llm-models qwen3-235b,qwen2.5-vl-32b

# On the M3 Ultra 96GB (LLM #2, default model + Whisper)
# Python ML CLIs (ml/transcribe.py, ml/diarize.py) invoked as subprocesses from transcribe_audio workers.
pnpm run worker -- --kinds transcribe_audio,analyze_intelligence,generate_asset \
                   --llm-host m3ultra-96gb.local:1234 \
                   --llm-models qwen3-32b

# On the M4 Max (master node, has ffmpeg + scene detect + fuse + clip render)
pnpm run worker -- --kinds ingest,fuse,clip_render

# On the Mac Minis (cheap parallelism)
pnpm run worker -- --kinds generate_asset,dispatch,collect_signal \
                   --llm-host m3ultra-96gb.local:1234 \
                   --llm-models qwen3-32b
```

The `worker` script is `workers/runner.ts`. The `--kinds` flag is parsed and used directly in the claim query (§6.1). `--llm-host` and `--llm-models` are forwarded to LLM-calling workers via the OpenAI-compatible client. The M3 Ultras additionally host the Python ML CLIs from §5.6; they are not separate processes but are spawned on demand by the relevant workers.

Note: `analyze_intelligence` is listed on both Ultras so the cheaper Qwen3 32B can pick up routine packages and the 512GB Ultra reserves capacity for premium passes with Qwen3 235B. The priority field on the job row decides which worker actually claims it (premium packages get priority 1, routine ones priority 5).

The claim query becomes filtered:

```sql
WHERE status = 'pending'
  AND kind = ANY($worker_kinds)
  AND run_after <= now()
```

### 6.4 Failure handling

- On exception: `status = 'failed'`, increment `attempts`, set `last_error`.
- If `attempts < max_attempts`: requeue with exponential backoff (`run_after = now() + interval '1 minute' * 2^attempts`).
- After `max_attempts`: leave as `failed`; visible in the dashboard's error queue for manual triage. No automatic dead-letter, because a local-first system with one operator should surface failures, not bury them.

---

## 7. Local Mac fleet topology

The fleet is already in place. ChannelHelm slots in alongside DojoClaw without requiring new hardware.

| Mac                          | Role in ChannelHelm                                                                  | Services running                                               |
|------------------------------|--------------------------------------------------------------------------------------|----------------------------------------------------------------|
| **M4 Max 36GB** (master)     | Primary node. PostgreSQL master, Next.js app, DojoClaw API, ingest + fuse + clip render | `postgres`, `next start` (port 3000), `dojoclaw-api`, `tsx workers/runner.ts --kinds ingest,fuse,clip_render`, `ffmpeg` |
| **M3 Ultra 512GB**           | Premium LLM + VLM. Heavy visual analysis + premium intelligence passes               | `lm-studio` (Qwen3 235B A22B MLX 6BIT), `mlx-vlm` (Qwen2.5-VL 32B) loaded on demand, `tsx workers/runner.ts --kinds analyze_visual,analyze_intelligence,generate_asset`; `ml/describe_frames.py` invoked as subprocess by `analyze_visual` workers |
| **M3 Ultra 96GB**            | Whisper + default LLM. Audio transcription + routine intelligence + bulk generation  | `lm-studio` (Qwen3 32B MLX 8BIT), `tsx workers/runner.ts --kinds transcribe_audio,analyze_intelligence,generate_asset`; `ml/transcribe.py`, `ml/diarize.py` invoked as subprocesses by `transcribe_audio` workers |
| **Mac Mini M4 #1**           | Dispatch + signal collection (low resource, network-bound)                            | `tsx workers/runner.ts --kinds dispatch,collect_signal`                                       |
| **Mac Mini M4 #2**           | Spare generation, webhook receiver, media file serving via Cloudflare Tunnel          | `tsx workers/runner.ts --kinds generate_asset`, `cloudflared` tunnel, `nginx` for `/media/*` (webhook endpoints are Next.js API routes on M4 Max served through the same tunnel) |

### 7.1 Network assumptions

- All Macs are on the same LAN, static IPs.
- PostgreSQL listens on the LAN interface, not just localhost. Auth via `pg_hba.conf` restricted to the LAN subnet plus a strong password.
- OpenClaw (existing AI gateway at `192.168.0.156:18789`) is optional. ChannelHelm workers can talk to LM Studio directly via its OpenAI-compatible endpoint, or route through OpenClaw for centralized model routing and logging. Recommendation: route through OpenClaw because it already gives you provider failover (local → cloud Anthropic API) which is useful when local inference is saturated.

### 7.2 Webhook receiver problem

Zernio webhooks come from the public internet. The local-first constraint means there is no public hostname by default. Two acceptable solutions:

1. **Cloudflare Tunnel** (recommended) — free, persistent, no port forwarding, terminates HTTPS, points at a local URL. Webhook receivers are Next.js API routes (`app/api/webhooks/zernio/route.ts`, `app/api/webhooks/dojoclaw/route.ts`) served by the Next.js app on M4 Max and exposed through the tunnel. Same pattern works for DojoClaw if needed.
2. **Tailscale Funnel** — works the same way, slightly different operator ergonomics.

Both are acceptable. Cloudflare Tunnel preferred because Cloudflare's DNS/proxy stack is already used across the StrongMocha portfolio.

### 7.3 Media storage

- Default: `/var/channelhelm/media/` on the M4 Max, exported over SMB or NFS to other Macs read-only for transcription and clip preview.
- Layout: `/var/channelhelm/media/{brand_slug}/{source_id}/{original.mp4, transcript.vtt, clips/, thumbs/}`.
- Object storage (S3, R2) is explicitly deferred. The local NAS-style export is sufficient for v1 throughput.

---

## 8. DojoClaw integration contract

### 8.1 Transport

HTTP/JSON over the LAN. DojoClaw exposes a local API at `http://m4max.local:8788/` (or whatever DojoClaw's existing API host is). ChannelHelm calls it as a service.

### 8.2 The brief → article handoff

ChannelHelm produces an `article_brief` asset, then a `dispatch` worker POSTs it to DojoClaw.

**Request (ChannelHelm → DojoClaw):**

```http
POST /api/v1/articles/from-brief
Content-Type: application/json
Authorization: Bearer <local-shared-secret>

{
    "brief_id": "ast_01HXYZ...",
    "source_package_id": "pkg_01HXYZ...",
    "brand_slug": "thorstenmeyerai",

    # Editorial direction
    "working_title": "Why the SaaS-to-Agent Transition Is Already Underway",
    "angle": "Skeptical analysis of vendor framing around agentic AI; uses retention data from the source video to back claims",
    "primary_keyword": "agentic AI SaaS",
    "secondary_keywords": ["AI agents", "post-SaaS", "Claude agents"],
    "target_word_count": 1800,
    "target_audience": "Technical founders evaluating AI infrastructure",

    # Voice anchoring
    "voice_profile_ref": "brand:thorstenmeyerai",
    "voice_example_ids": [1247, 1903, 2104],   # top-performing past articles

    # Source material — the meat
    "key_points": [
        "Agentic AI is not a feature, it's an architectural rewrite",
        "...",
    ],
    "quotes_from_source": [
        {"timestamp": "12:34", "text": "...", "speaker": "Thorsten Meyer"},
        ...
    ],
    "source_video_url": "https://www.youtube.com/watch?v=...",
    "source_transcript_excerpt": "...",   # ~1500 words of the most relevant transcript

    # Publishing direction
    "target_site": "thorstenmeyerai.com",
    "target_category": "ai",
    "target_author": "thorsten-meyer",
    "must_link_to": [
        "https://thorstenmeyerai.com/posts/agentic-ai-disruption",
        ...
    ],
    "syndication_targets": [],   # e.g. ["strongmocha.com/category/ai"]

    # Webhook for completion
    "callback_url": "https://channelhelm.<tunnel>.com/webhooks/dojoclaw"
}
```

**Immediate response (synchronous, just acknowledges):**

```json
{
    "dojoclaw_job_id": "djw_01HXYZ...",
    "estimated_completion_seconds": 240,
    "status": "queued"
}
```

ChannelHelm stores `dojoclaw_job_id` in the asset's `dispatch.external_id`.

**Webhook (DojoClaw → ChannelHelm, async, when article is ready):**

```http
POST /webhooks/dojoclaw
Content-Type: application/json

{
    "event": "article.completed",
    "dojoclaw_job_id": "djw_01HXYZ...",
    "brief_id": "ast_01HXYZ...",
    "result": {
        "article_id": "djw_art_...",
        "title": "...",
        "slug": "...",
        "excerpt": "...",
        "content_html": "...",
        "content_markdown": "...",
        "categories": ["ai"],
        "tags": [...],
        "faqs": [...],
        "schema_jsonld": {...},
        "social_snippets": {
            "linkedin": "...",
            "x": "...",
            "facebook": "..."
        },
        "syndication_variants": [
            {"target_site": "...", "title": "...", "content_html": "..."}
        ],
        "wordpress_status": "draft" | "published",
        "wordpress_url": "https://thorstenmeyerai.com/...",
        "wordpress_post_id": 4821
    }
}
```

The ChannelHelm webhook receiver writes to `webhook_events`, a worker processes it, updates the asset's `dispatch.result` and `status = 'published'`, and optionally creates linked assets (e.g. promote the new article's URL into a fresh LinkedIn post on the Zernio side).

### 8.3 What ChannelHelm does NOT ask DojoClaw to do

- Image generation for article featured images. DojoClaw already owns its Playwright/PIL pipeline for editorial featured images and keeps doing so. ChannelHelm sends thumbnail concepts for YouTube only.
- Direct social posting. Even though DojoClaw can syndicate, social posts go through Zernio for unified scheduling and signal collection.

---

## 9. Zernio integration contract

### 9.1 Auth and base URL

```
Base URL: https://zernio.com/api/v1/
Auth:     Authorization: Bearer sk_<64-hex>
SDK:      Node `zernio` package preferred. A thin typed `fetch` client is acceptable
          when the SDK lags behind a needed Zernio field, in tests/mocks, or in
          environments where adding the SDK is friction. The fetch client must:
            - share the same request/response types (zod schemas) as the SDK wrapper
            - log every call to the `dispatches` table identically
            - be a single module (workers/integrations/zernio_http.ts), not scattered
              ad-hoc calls
          Direct, untyped `fetch` calls outside that module are not allowed.
```

API key stored in `~/.config/channelhelm/secrets.env`, loaded into the dispatch worker only.

### 9.2 Brand provisioning (one-time per Brand)

When a new Brand is created in ChannelHelm, the system provisions a matching Zernio Profile:

```ts
const profile = await zernio.profiles.create({ name: brand.name });
brand.zernioProfileId = profile._id;   // prof_abc123
```

Connecting social accounts uses Zernio's OAuth-as-a-service. ChannelHelm's dashboard exposes a "Connect account" button that calls:

```ts
const { authUrl } = await zernio.connect.getConnectUrl({
    platform: "linkedin",
    profileId: brand.zernioProfileId,
});
```

User is redirected through Cloudflare Tunnel → Zernio OAuth → back to ChannelHelm. Account IDs come back via `zernio.accounts.listAccounts({ profileId })`.

### 9.3 Posting an asset

The dispatch worker turns approved assets into Zernio post requests. The mapping is per-asset-type:

**LinkedIn post:**

```ts
await zernio.posts.create({
    content: asset.payload.text,
    platforms: [
        { platform: "linkedin", accountId: linkedinAccountId },
    ],
    scheduledFor: scheduledIso,            // or omit for "now"
    firstComment: asset.payload.firstComment ?? undefined,
    metadata: {
        channelhelmAssetId: asset.id,       // for webhook correlation
        channelhelmPackageId: asset.packageId,
        channelhelmBrandId: asset.brandId,
    },
});
```

**X thread:**

Zernio's API treats threads as a sequence of posts with a parent reference. The dispatch worker creates them in order.

**Short clip dispatch (TikTok/Reels/Shorts).** The dispatch worker reads a `rendered_short_clip` asset (produced by `clip_render` from a `short_clip_plan`), pulls the caption from the matching platform-specific caption asset (`tiktok_caption`, `reels_caption`, `instagram_caption`) referenced via `media_refs`, and posts:

```ts
await zernio.posts.create({
    content: captionAsset.payload.text,
    mediaUrls: [renderedClip.payload.publicUrl],   // see 9.4 on media hosting
    platforms: [
        { platform: "tiktok",    accountId: tiktokAccountId },
        { platform: "instagram", accountId: igAccountId,
          platformOptions: { mediaType: "reel" } },
        { platform: "youtube",   accountId: ytAccountId,
          platformOptions: { mediaType: "short" } },
    ],
    scheduledFor: scheduledIso,
    metadata: {
        channelhelmAssetId: renderedClip.id,
        channelhelmCaptionAssetId: captionAsset.id,
        channelhelmPackageId: renderedClip.packageId,
        channelhelmBrandId: renderedClip.brandId,
    },
});
```

A `short_clip_plan` asset is never passed to `zernio.posts.create`. Attempting to dispatch one is a programming error and the dispatch worker raises before making the HTTP call.

### 9.4 Media hosting for Zernio

Zernio requires public URLs for `mediaUrls`. Local files are not reachable. Two options:

1. **Serve clips via the same Cloudflare Tunnel** (recommended) — clips are written to `/var/channelhelm/media/.../clips/` and served by a tiny nginx config under `https://channelhelm.<tunnel>.com/media/...`. Signed URLs with short TTLs to prevent crawling. Zero new infrastructure.
2. **Push to R2/S3 before dispatch** — adds dependency, but more durable for high-volume.

Choose #1 for v1. Document #2 as the v2 upgrade path if dispatch volume exceeds local bandwidth.

### 9.5 Inbound webhooks from Zernio

Zernio publishes `post.published`, `post.failed`, and analytics events. The webhook receiver writes to `webhook_events`, the processor worker correlates via the `metadata.channelhelm_asset_id` field, updates `assets.dispatch` and `assets.signals`, and emits `collect_signal` follow-up jobs as needed.

### 9.6 Rate limiting

The AppSumo Tier 4 plan limit is 20 posts per day per social account. The dispatch worker enforces this **before** calling Zernio:

```sql
SELECT count(*) FROM dispatches
 WHERE target = 'zernio'
   AND success = TRUE
   AND dispatched_at >= now() - interval '24 hours'
   AND request_payload->'platforms' @> $1::jsonb;
```

If count >= 20: requeue the dispatch job with `run_after = (start of next UTC day)`. Surface in the dashboard so the operator knows their queue is full.

---

## 10. Approval workflow

The approval gate is what makes ChannelHelm a publisher's tool rather than a content sprayer. Every asset has an `approval_required` flag derived from the Brand's policy. Packages move through this state machine, which mirrors the worker chain in §6.2:

```
draft
  │
  ├─ job: ingest                                  (yt-dlp, audio extract, scene detect)
  ▼
ingested
  │
  ├─ fan out (parallel) ────────────────────────────────┐
  │  job: transcribe_audio                              │  job: analyze_visual
  │  (MLX Whisper, optional WhisperX diarization)        │  (frames + Apple Vision OCR + Qwen2.5-VL)
  ▼                                                      ▼
  └──────────────── join when both done ────────────────┘
                          │
                          ├─ job: fuse                  (build scene log)
                          ▼
                      fused
                          │
                          ├─ job: analyze_intelligence  (Qwen3 → topics, hooks, retention)
                          ▼
                      analyzed
                          │
                          ├─ jobs: generate_asset       (one per asset type, parallel)
                          │
                          ├─ jobs: clip_render          (one per entry in each *_plan asset;
                          │                              produces rendered_short_clip and
                          │                              rendered_long_clip assets)
                          ▼
                  ready_for_review
                          │
                          ├─ Operator opens dashboard, reviews each asset
                          ├─ Per-asset actions: approve | reject | edit | regenerate
                          ▼
                      approved                  (when all non-auto assets are decided)
                          │
                          ├─ jobs: dispatch            (fanned out per approved asset
                          │                            to DojoClaw or Zernio; *_plan
                          │                            assets are never dispatched)
                          ▼
                    dispatching
                          │
                          ├─ all dispatches successful → dispatched
                          ├─ some failed → partially_dispatched (visible in error queue)
```

**Status field on packages.** The full set of `packages.status` values is now:
`draft | ingested | transcribing | analyzing_visual | fused | analyzed | ready_for_review | approved | dispatching | dispatched | partially_dispatched | failed`.

The `transcribing` and `analyzing_visual` states can coexist (a package is in `transcribing` until both parallel branches complete; the dashboard shows both per-branch progress). When both branches finish, the worker enqueues the `fuse` job and transitions the package to `fused` only after that job completes.

**Auto-dispatch rules.** Asset types listed in `brand.auto_dispatch_for` skip the review gate and dispatch as soon as they are produced. Plan assets (`short_clip_plan`, `long_clip_plan`) are blueprints, not dispatchable, and MUST NOT appear in `auto_dispatch_for`; the worker enforces this. Rendered clips (`rendered_short_clip`, `rendered_long_clip`) may be auto-dispatched only if their parent plan was approved by the operator — the gate sits on the plan, not the renders. This is the safe default and avoids publishing 8 derivative clips before the operator has seen the cut list.

**Regenerate vs edit.** "Edit" means the operator types over the payload directly in the dashboard. "Regenerate" creates a new `generate_asset` job with the same prompt version (or a bumped one) plus optional steering hints; per the idempotency convention in §4, a regeneration creates a new asset row rather than overwriting. Both actions add `voice_examples` rows if the operator marks the asset as exemplary.

---

## 11. Helm Signal — the feedback loop

This is the moat. ChannelHelm generates, observes, and learns.

### 11.1 What gets collected

Per asset, on a schedule (`collect_signal` job runs every 6h for the first 7 days post-publish, then daily for 30 days):

- **From Zernio:** impressions, reach, engagement, clicks, video views, completion rate (when available).
- **From YouTube** (for assets whose external_id is a YouTube video or Short): views, retention, CTR on the chosen title/thumbnail.
- **From DojoClaw / WordPress:** page views, time on page, Search Console position for the primary keyword (DojoClaw can expose this if integrated with GSC; if not, this is v2).

All metrics land in the `signals` table with `metric` as the discriminator.

### 11.2 How signals are used

Three mechanisms, in increasing sophistication:

**A. Dashboard surfacing.** Each Package gets a "Performance" tab showing post-by-post metrics across platforms. The operator immediately sees which titles, which clip cut-points, and which LinkedIn variants worked. Pure observation, no model changes.

**B. Voice example promotion.** Assets that perform above the brand's median for their type get their text promoted into `voice_examples` with a high `performance_score`. The next time the same asset type is generated for the same brand, the top-N examples are injected into the prompt as few-shot anchors. The model is learning indirectly — the prompt gets better, not the weights.

**C. Title/thumbnail A/B routing (v1.5).** For YouTube specifically, the title and thumbnail can be tested via the YouTube Studio experiments API. ChannelHelm queues both options as a single split test, collects the result, and the winner becomes a positive voice example. The loser becomes a negative ("avoid this pattern for this brand"). Out of v1 scope but the schema already supports it.

---

## 12. Stack summary

### 12.1 Application layer (TypeScript / Node)

| Layer              | Tech                                                                              | Justification                                                  |
|--------------------|-----------------------------------------------------------------------------------|-----------------------------------------------------------------|
| Database           | PostgreSQL 16 on M4 Max                                                            | Matches DojoClaw, proven SKIP LOCKED queue pattern             |
| Web app            | Next.js 15+ (App Router) + TypeScript strict                                       | Operator's existing TS muscle memory, one language across stack |
| UI components      | shadcn/ui + Tailwind                                                               | Standard, low friction with Claude Code                         |
| ORM                | Drizzle ORM + drizzle-kit migrations                                               | Type-safe, lightweight, schema-as-TS, fast migration generation |
| DB driver          | `pg` (node-postgres)                                                               | Required by Drizzle and the queue layer; LISTEN/NOTIFY ready    |
| Job queue          | Custom thin queue (~150 lines) on Postgres SKIP LOCKED                             | Matches §4 idempotency + priority conventions exactly           |
| Workers            | Node processes via `tsx workers/runner.ts --kinds X`, managed by `launchd`         | Same daemon pattern, TS instead of Python                       |
| LLM client         | `openai` npm package pointed at LM Studio's OpenAI-compatible endpoint              | Standard, supports OpenClaw routing transparently               |
| Zernio integration | Node `zernio` SDK + thin typed `fetch` fallback module                              | §9.1 rule preserved                                             |
| Validation         | Zod schemas, shared between API routes and workers                                  | Type-safe payload boundaries                                    |
| Tests              | Vitest + `@testcontainers/postgresql`                                              | Real Postgres in tests, no SQLite shim                          |
| Lint/format        | Biome                                                                              | Single tool replaces ruff + prettier, fast                      |
| Package manager    | pnpm                                                                               | Disk-efficient, workspaces-ready if needed later                |
| Process mgmt       | `launchd` per Mac (prod), `pm2` (dev)                                              | Native macOS, restarts on boot                                  |
| Secrets            | `.env` per Mac, loaded via Next.js + `dotenv` for workers                          | Local-first, no vault required                                  |

### 12.2 ML CLI layer (Python — isolated to four scripts)

| Layer            | Tech                                                                          | Justification                                              |
|------------------|-------------------------------------------------------------------------------|-------------------------------------------------------------|
| Runtime          | Python 3.12 managed by `uv`                                                    | Fast, isolated venv, lockfile                              |
| Transcription    | MLX Whisper large-v3                                                           | Native Apple Silicon, no Node equivalent at this speed     |
| Diarization      | WhisperX + pyannote-audio (only when speaker_count > 1)                        | No Node equivalent                                          |
| Vision-language  | Qwen2.5-VL 32B via `mlx-vlm` (fallback: Qwen2.5-VL 7B)                         | No MLX equivalent for Node                                  |
| OCR              | Apple Vision framework (`VNRecognizeTextRequest` via `pyobjc`)                 | Native, free, Neural Engine; community Node bindings are weak |
| Audio features   | librosa for pace/energy, simple emphasis-word heuristics                       | CPU-cheap, no extra models                                  |
| Invocation       | `uv run python ml/{script}.py --input ... --output ...`                        | Subprocess from Node workers, see §5.7                      |

### 12.3 System layer (shared)

| Layer            | Tech                                                                          | Justification                                              |
|------------------|-------------------------------------------------------------------------------|-------------------------------------------------------------|
| LLM hosting      | LM Studio: Qwen3 32B MLX 8BIT default, Qwen3 235B A22B MLX 6BIT premium        | Existing fleet, zero new spend                              |
| LLM gateway      | OpenClaw at 192.168.0.156:18789 (optional, recommended)                        | Centralized routing + failover to cloud Anthropic API       |
| Scene detection  | ffmpeg scene filter (threshold 0.3) or PySceneDetect via subprocess            | Cut-point timestamps for clip boundaries                    |
| Video processing | ffmpeg (system, spawned from Node)                                             | Standard                                                    |
| Media downloader | yt-dlp (system, spawned from Node)                                             | Standard for YouTube ingestion                              |
| Public ingress   | Cloudflare Tunnel                                                              | Free, no port forwarding, terminates TLS                    |
| Tunneling target | Zernio + DojoClaw webhooks (Next.js API routes) + media serving (`nginx`)      | One tunnel covers all three                                 |
| Media storage    | Local `/var/channelhelm/media/`, SMB/NFS exported to other Macs read-only      | Object storage deferred to v2                               |

---

## 13. Build sequence (v1 MVP)

Strict ordering. Do not skip ahead.

1. **Next.js project + Drizzle schema + initial migration.** Scaffold Next.js 15 App Router with TS strict. Define every table from §4 in `src/db/schema.ts` using Drizzle. Generate the initial migration via `drizzle-kit generate`. Seed one Brand row for `thorstenmeyerai`. **Acceptance:** `pnpm drizzle-kit migrate` runs cleanly against local Postgres; `scripts/smoke-schema.ts` inserts brand → source → package and exits 0.
2. **Next.js API routes + auth.** Local-only bearer token, single operator. Routes under `app/api/`: `brands`, `sources`, `packages`, `assets` with GET/POST/PATCH where appropriate. Zod schemas shared with workers. **Acceptance:** CRUD round-trips via `curl` and via the Next.js dev server.
3. **Worker daemon skeleton (`workers/runner.ts`).** Node entry point implementing the SKIP LOCKED claim loop in `workers/queue.ts` (~150 lines). Single kind: `noop`. **Acceptance:** Enqueue a `noop` job via the API; observe `tsx workers/runner.ts --kinds noop` claim and complete it.
4. **Ingest worker.** Node worker that spawns yt-dlp + ffmpeg as subprocesses to extract audio and run scene detection. Writes `local_media_path` and seeds `scene_cuts` on the package's `intelligence` block. **Acceptance:** Submit a YouTube URL, see MP4 + audio.wav + scene_cuts populated.
5. **Audio transcription worker.** Node worker that spawns `ml/transcribe.py` (MLX Whisper large-v3) and, when pyannote VAD detects >1 speaker, `ml/diarize.py`. Worker parses the JSON status, reads the output file, attaches provenance, writes to Postgres. **Acceptance:** Solo and multi-speaker videos both produce correct transcripts.
6. **Visual analysis worker.** Node worker that runs ffmpeg frame sampling + spawns `ml/ocr.py` (Apple Vision) and `ml/describe_frames.py` (Qwen2.5-VL via mlx-vlm). **Acceptance:** Frame index JSON has descriptions and OCR text for every sampled frame.
7. **Fuse worker.** Pure TypeScript — merges transcript + diarization + visual descriptions + OCR + audio features into `scene_log.json` aligned to 5-10s windows. **Acceptance:** Scene log loads and validates against the Zod schema generated from §5.2.
8. **Intelligence worker.** Node worker that calls Qwen3 32B via the `openai` client pointed at LM Studio. Consumes the scene log, populates topics/entities/hooks/retention/summaries. **Acceptance:** Package row has fully populated `intelligence` JSONB.
9. **Generate-asset workers — text assets first.** Implement `youtube_title_set`, `youtube_description`, `youtube_chapters`, `youtube_tags`, `linkedin_post`, `x_post`, `x_thread`, `article_brief`, `newsletter_summary` as nine prompts (markdown files under `prompts/`) consumed by a single TS asset-generation function. **Acceptance:** All nine assets exist in `assets` table after analysis.
10. **Dashboard v0.** Next.js Server Components for Packages list and Package detail with all assets, scene-log timeline view, approve/reject Server Actions. **Acceptance:** Operator can review an entire package in the browser.
11. **Approval gate + dispatch worker for DojoClaw.** Wire `article_brief` → DojoClaw API via `fetch` from a `dispatch` worker. Webhook receiver at `app/api/webhooks/dojoclaw/route.ts` writes `article.completed` events. **Acceptance:** Approved brief becomes a WordPress draft on thorstenmeyerai.com.
12. **Dispatch worker for Zernio.** Wire `linkedin_post`, `x_post` to Zernio via the Node `zernio` SDK. Webhook receiver at `app/api/webhooks/zernio/route.ts` writes `post.published` events with idempotency on `source_event_id`. **Acceptance:** Approved LinkedIn post appears on LinkedIn on schedule.
13. **Cloudflare Tunnel.** Expose Next.js webhook routes and `/media/*` (nginx) URLs. **Acceptance:** Zernio successfully POSTs `post.published` to the tunnel and the asset's signals start populating.
14. **Clip generation.** `analyze_intelligence` produces `short_clip_plan` assets (blueprints, never dispatched). The `clip_render` worker consumes each plan entry and spawns ffmpeg to produce one `rendered_short_clip` asset per entry, with vertical crop and optional burned-in subtitles. The dispatch worker (step 12) handles these — `short_clip_plan` is rejected at dispatch time as a programming error. **Acceptance:** Approving a plan produces N rendered clips on disk; one rendered clip posts to Instagram via Zernio.
15. **Thumbnail concepts.** Frame extraction at top-scored hook timestamps + canvas/sharp overlay generation in TypeScript (no Python needed for this step). **Acceptance:** Three thumbnail JPGs per package.
16. **`collect_signal` worker.** Periodic Zernio analytics pull via SDK, write to `signals` table. **Acceptance:** Performance tab in dashboard shows numbers.
17. **Voice example promotion.** Top-decile performing assets auto-tagged as voice examples for their brand+type. **Acceptance:** Next generation of the same asset type uses them as few-shot.

Items 1-12 are the true MVP — at that point ChannelHelm understands a video end-to-end, produces a real Publishing Package, and dispatches it. Items 13-17 close the feedback loop and add the moat.

---

## 14. Changes made after contract cleanup review

This section records the corrections applied during cleanup passes. It exists so future reviewers can see what was caught and why, without diffing the markdown.

### 14.1 v1.3 — stack flip to Next.js + TypeScript (current)

The backend, workers, and frontend all flip from Python/FastAPI/React+Vite to TypeScript across Next.js (App Router) for UI/API and Node processes (`tsx workers/runner.ts`) for workers. Four MLX-bound steps remain in Python as single-file CLI scripts under `ml/`, invoked by Node workers via `child_process.spawn`. Specifically:

- **Application:** Next.js 15+ with App Router, Server Components by default, Server Actions for mutations, API routes for webhooks. Runs on the M4 Max master.
- **ORM:** Drizzle ORM with `drizzle-kit` migrations. The schema in §4 is the source of truth; Drizzle's `src/db/schema.ts` mirrors it exactly.
- **Workers:** Node processes managed by `launchd`, claim loop written in TS directly against `pg` with the SKIP LOCKED idiom verbatim from §6.1. Custom thin queue layer in `workers/queue.ts` (~150 lines), not Graphile Worker.
- **Python isolation:** Reduced to four files — `ml/transcribe.py`, `ml/diarize.py`, `ml/describe_frames.py`, `ml/ocr.py` — invoked as subprocesses. The Node ↔ Python contract is in §5.6.
- **Zernio SDK:** Node `zernio` package; thin typed `fetch` fallback in `workers/integrations/zernio_http.ts`.
- **Tooling:** pnpm, Biome, Vitest, `@testcontainers/postgresql`, tsx.

**What is NOT changed by v1.3:** the schema (§4), the scene log (§5.2), the processing profiles (§5.5), the integration contracts (§8 and §9), the approval workflow (§10), the provenance fields (§2.2), the idempotency conventions (§4 and §6), and the Helm Signal feedback loop (§11). Every load-bearing decision was language-agnostic by design and survives the flip without modification. Only the implementation artifacts — package manifests, code examples, the build sequence steps — changed.

### 14.2 v1.2 — cleanup-review patches

**1. `short_clip_plan` is not dispatchable.** Earlier drafts listed `short_clip_plan` in `routing.zernio` and in `auto_dispatch_for`, which would have caused the dispatch worker to POST a blueprint JSON to Zernio's `mediaUrls` field — a guaranteed failure with confusing error messages. Plans are now strictly internal artifacts:

- `short_clip_plan` and `long_clip_plan` are produced by `analyze_intelligence` and live under `routing.internal`.
- The `clip_render` worker consumes a plan and produces one `rendered_short_clip` (or `rendered_long_clip`) asset per clip entry, with a `local_path`, dimensions, and a `public_url` populated when the file becomes reachable through Cloudflare Tunnel.
- Only `rendered_*` assets can be dispatched. The dispatch worker raises on any attempt to dispatch a `*_plan` asset.

**2. Auto-dispatch defaults tightened.** `brand.auto_dispatch_for` now defaults to an empty list. `*_plan` types are forbidden from this list and the worker enforces it. Rendered clips may be auto-dispatched only if their parent plan was approved by the operator — the gate sits on the plan.

**3. Approval workflow state machine rewritten.** The state machine in Section 10 now mirrors the worker chain exactly:
`ingest → (transcribe_audio ∥ analyze_visual) → fuse → analyze_intelligence → generate_asset + clip_render → review → dispatch`. The `packages.status` enum gained `ingested`, `transcribing`, `analyzing_visual`, `fused`, and `analyzed` to make the parallel and sequential transitions visible in the dashboard.

**4. Processing profiles added.** Section 5.5 defines three profiles — `fast_audio_only`, `standard_audio_visual`, `premium_multimodal` — controlling which pipeline layers run and which models are used. The profile is stored on `packages.processing_profile` and propagated into every artifact's `provenance.profile`. Brands carry a `default_processing_profile`; operators can override per package.

**5. Provenance fields expanded.** Every generated artifact — LLM text, Whisper transcripts, VLM frame descriptions, OCR results, scene log, rendered clips — now carries a uniform provenance block with `provider`, `model`, `host`, `prompt_version`, `input_refs`, and `generated_at`. The `input_refs` chain makes it possible to trace any output back to the exact inputs that produced it, which is what Helm Signal needs to learn from.

**6. Webhook idempotency.** `webhook_events` gained a `source_event_id` column and a unique index on `(source, source_event_id)`. Redelivered webhooks from Zernio or DojoClaw collide at insert time, the receiver swallows the duplicate-key error with HTTP 200, and no event is processed twice. When the sender doesn't provide an event ID, the receiver synthesizes a stable one by hashing event_type + external_id + minute-floored timestamp.

**7. Job idempotency.** `jobs` gained an `idempotency_key` column and a partial unique index on `(kind, idempotency_key) WHERE idempotency_key IS NOT NULL`. Conventions are documented inline in the schema (e.g. `fuse:{source_id}:{profile}`, `clip_render:{plan_asset_id}:{clip_index}`, `dispatch:{asset_id}`). This prevents accidental double-fusion, double-rendering, and double-dispatch when a worker crashes mid-job and is restarted before its lock expires. Intentional re-runs (regenerate-asset) create new asset rows rather than overwriting.

**8. Zernio SDK rule relaxed.** Section 9.1 previously said "use the SDK, don't hand-roll HTTP." Now: prefer the SDK, but a thin typed httpx client (single module, shared pydantic models, same dispatch logging) is acceptable when the SDK lags behind a needed field or in tests. Ad-hoc untyped `requests`/`httpx` calls are still forbidden.

**9. This section.** Added as a record of the cleanup pass.

*(Historical note as of v1.2: the contract remained local-first; PostgreSQL, FastAPI, Python workers, DojoClaw as a local service, Zernio as the only external cloud dependency, and the scene log architecture all remained unchanged. v1.3 subsequently flipped FastAPI → Next.js and Python workers → Node workers; see §14.1.)*

---

## 15. What this contract deliberately does not cover

- **Backlog Revival** — separate spec, depends on this contract but extends it. Will be ChannelHelm v1.1.
- **Multi-operator / team accounts** — local-first, single operator, by design. Add in v2 if Thorsten brings on a content ops hire.
- **Mobile app** — out of scope. Dashboard is browser-only.
- **Public-facing SaaS productization** — explicitly not the v1 product. ChannelHelm is internal infrastructure for the Meyer publishing operation. If it productizes later, that's a separate refactor with multi-tenancy as the central concern.
- **Specific prompt engineering for each asset type** — the prompts themselves are a separate, living artifact (`prompts/{asset_type}.v{N}.md`) that evolves continuously and shouldn't be frozen in the architecture contract.

---

**End of v1 technical contract.**

---

## Addendum (2026-05-22) — status enum clarifications

Resolving review issue #2:

- **§10 package statuses** are enforced exactly as listed:
  `draft · ingested · transcribing · analyzing_visual · fused · analyzed ·
  ready_for_review · approved · dispatching · dispatched · partially_dispatched ·
  failed`. `published` is **not** a package status (only assets publish).
- **§2.2 asset statuses** are `draft · approved · rejected · dispatched ·
  published · failed`, **plus** one documented internal marker:
  **`ready_for_review`** — an asset has been generated and is awaiting operator
  approval. It sits between `draft` and `approved` and never leaves the local
  system. The dispatch worker writes `dispatched` on a successful handoff;
  webhooks move assets to `published` or `failed`.

These are codified in `src/lib/schemas.ts` (`PackageStatus`, `AssetStatus`).

---

## Addendum (2026-05-26) — runtime settings

Introduces a runtime-editable settings system so the operator can change non-boot environment values from the `/settings` page without editing `.env` and restarting. Detailed architecture lives in `docs/settings.md`; this is the contract-level commitment.

**Table.** `settings(key text PK, value text, encrypted boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now())`. Migration `0005_settings.sql`.

**Hydration path.** Two shapes:

- **Workers** call `loadSettingsIntoEnv()` + `subscribeSettingsChanges()` at startup in `workers/runner.ts`. The LISTEN client (a dedicated `pg.Client`, separate from Drizzle's pool — LISTEN holds the connection) refreshes individual keys into `process.env` on every notification. Auto-reconnect on error after 5 s.
- **Next.js** uses lazy hydration. Route handlers or Server Components that read runtime-editable env keys call `hydrateRuntimeSettingsForRoute(routeName)` at request entry before touching `process.env`; `setSetting()` also calls `ensureHydrated()` defensively before writes. Turbopack's instrumentation bundling won't tolerate `pg`'s `require('fs')` / `dotenv`'s `require('path')`, so there is intentionally no `src/instrumentation.ts`.

Either way: secrets are decrypted via `secret-box` (AES-256-GCM keyed by `PROVIDER_SECRET_KEY`). Empty/null rows never clobber `.env`. Every existing `process.env.X` consumer keeps working unchanged; DB wins over `.env` on conflict.

**Live propagation.** `setSetting(key, value)` upserts the row, applies the change to the local `process.env`, and fires `pg_notify('chs_settings', key)`. The worker LISTEN client picks it up and refreshes its env. Cross-direction: if a worker writes a setting (rare — usually only the operator via the UI does), the Next.js side picks it up via `ensureHydrated()` on the next GET (and via local apply on its own writes).

**Editable surface.** The catalogue is fixed in `SETTINGS_CATALOGUE` (`src/lib/settings.ts`). Any key not listed is refused by `setSetting()` (400 from `/api/settings`).

- **Runtime-editable** (live, no restart): `ZERNIO_API_KEY`, `ZERNIO_WEBHOOK_SECRET`, `DOJOCLAW_API_URL`, `DOJOCLAW_API_KEY`, `DOJOCLAW_WEBHOOK_SECRET`, `HF_TOKEN`, `CLOUDFLARE_TUNNEL_HOSTNAME`, `MEDIA_URL_SECRET`, `MEDIA_REQUIRE_SIGNATURE`, `ALLOW_UNSIGNED_WEBHOOKS`, `MAX_UPLOAD_BYTES`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `ARCHIVE_AFTER_DAYS`, `ARCHIVE_DELETE_CLIPS`.
- **Boot-only** (read-only in UI, edit `.env` + restart): `DATABASE_URL`, `MEDIA_ROOT`, `ARCHIVE_ROOT`, `LOCAL_BEARER_TOKEN`, `PROVIDER_SECRET_KEY`. Mid-flight rotation of any of these breaks running workers (lost DB connections, lost auth tokens, undecryptable provider keys).

**LLM providers are explicitly NOT a setting.** They live in `llm_providers` and are edited at `/providers` (per-purpose routing, per-row encryption, test connection). The DojoClaw `src/lib/llm` pattern is the reference. This separation is permanent — provider configuration is multi-row + structured; settings are flat key/value.

**API.** `GET /api/settings` returns `{ items, migrationNeeded, subscriberStatus }`. Secrets are masked with `••••••••`. `PUT /api/settings` accepts `{ KEY: value, … }`; submissions equal to the mask placeholder are skipped (DojoClaw pattern); boot-only keys 400. Both routes require `Authorization: Bearer $LOCAL_BEARER_TOKEN`. The dashboard saves through `src/server-actions/settings.ts`, not unauthenticated browser `fetch`.

**Operator constraint.** New runtime-editable env keys MUST be added to `SETTINGS_CATALOGUE` first — otherwise the `/settings` page won't render them and the operator has to edit `.env`. Boot-only keys also belong in the catalogue (with `bootOnly: true`) so they appear in the read-only section with the "edit `.env` and restart" hint.

---

## Addendum (2026-05-26) — pipeline performance pass

Three optimizations to the §5/§6 pipeline, measured on a representative 7:18 / standard_audio_visual run. Combined: the pipeline drops from ~25–30 min to ~2–2.5 min end-to-end (~10–12×). No schema changes, no new dependencies.

**(A) Scene-cut-driven VLM sampling** (`workers/kinds/analyze_visual.ts::pickVlmTimestamps`). The VLM no longer runs at fps=1; it runs at scene cuts (already detected by ingest, stored on `packages.intelligence.scene_cuts`) plus intro/outro plus one frame per 30 s of static gap. On the 7:18 measurement, **18 keyframes instead of 438**. The fuse layer's `composeSceneLog` still reads the same dense `frame_index.frames` array — the merge propagates each VLM keyframe's description forward to every OCR row until the next keyframe, so backwards compatibility is preserved.

**(B) VLM input downscale to 768 px long-axis.** A second ffmpeg pass writes `frames_vlm/` JPEGs at 768 px (vs source resolution for OCR's `frames_ocr/`). Qwen2.5-VL's dynamic tokenization scales with pixels — 768 px frames produce ~4× fewer vision tokens than 1080 p. Roughly 2–4× faster per VLM call.

**(C) Parallel OCR + VLM.** The two ml subprocesses (`ml/ocr.py`, `ml/describe_frames.py`) read independent manifests, write independent files, share zero state. Now run in `Promise.all` — Visual phase wall is `max(OCR_wall, VLM_wall)` instead of `OCR_wall + VLM_wall`.

**(D) Worker concurrency** (`workers/runner.ts --concurrency N`, default 3). The runner spawns N independent claim slots in the same process, each running its own claim→handler→ack loop. The queue's `SELECT FOR UPDATE SKIP LOCKED` is the only mutex — no in-process locking is needed. LLM-bound kinds (generate_asset ×N per package, analyze_intelligence) finish ~3× faster. CPU-bound kinds (the ml subprocesses) see modest gains from overlapping I/O. Tune via env `WORKER_CONCURRENCY` or the flag.

**(E) Profile-aware OCR fps** (`workers/kinds/analyze_visual.ts::OCR_FPS_BY_PROFILE`). Standard profile drops OCR to 0.5 fps (every 2 s); premium stays at 1 fps. Halves OCR wall on standard with no measurable quality loss on overlay/lower-third detection. Per-profile means premium clients still get dense OCR for high-stakes content where a single-frame overlay could matter.

**Per-handler concurrency safety.** With (D) active, multiple handlers of the same kind may run in parallel. Handlers were audited to be idempotent at the row level:
- `generate_asset`: writes a single asset row per (package_id, asset_type); no two parallel jobs hit the same row.
- `markReadyForReviewIfComplete` (called by generate_asset): pure status-update — final state is deterministic regardless of call ordering.
- `recomputePackageDispatchState` (called by dispatch): same — derives package state from current asset rows.
- `patchPackageIntelligence` (called by analyze_visual / fuse / analyze_intelligence): these handlers are gated by single-source idempotency keys (`analyze_visual:{sourceId}:{profile}`, etc.), so two never run simultaneously for the same source.
- The dispatch worker's `youtube_direct` branch reads sibling asset payloads and writes back via `db.update(assets).where(inArray(assets.type, [...]))` — safe even if concurrent generate_asset jobs are still landing, because dispatch only runs after operator approval (post-pipeline).

**Performance measurements (7:18 video, standard_audio_visual, M-Studio):**
- Before (everything pre-this-addendum): ~25–30 min
- After A+B+C only: ~3.5–4 min (Visual phase: ~10–15 min → ~65 s)
- After A+B+C+D+E: ~2–2.5 min (generate_asset batch: ~100 s → ~35 s)

---

## Addendum (2026-05-27) — Shorts editor + per-Short metadata + publish flow

A full Shorts editor lands on top of the existing pipeline. Zero DB migrations — all changes are JSONB payload shape extensions and new UI / server-action / worker code.

**§2.3 short_clip_plan.payload (v2).** The prompt at `prompts/short_clip_plan.v2.md` now generates per-clip `title` (≤ 70 chars, required), `description` (≤ 280 chars), `tags` (5–10 strings), and `hook_score` (0..1). Plan count bumped from 1–5 clips to 3–8 clips per video. The plan is the editable source of truth — operator edits to title/description/tags/styling/trim/publish_options live here.

Operator-set fields on each `clips[i]`:
- `trim?: { start, end }` — word-snapped trim override (LLM-suggested start/end stay as defaults)
- `styling?: { font, font_size, font_color, highlight_color, animation, x_pos, y_pos }` — subtitle styling block; consumed by `src/lib/ass-subtitles.ts` at render time
- `description_links?: { label, url }[]` (≤ 8) — appended to the post body at dispatch
- `b_roll_enabled?: boolean` — UI flag, no rendering effect in v1 (b-roll insertion deferred)
- `publish_options?: { platforms, privacy, publish_at }` — per-clip publish state
- `render_rev?: number` — monotonic revision bumped on each operator "Render" click; idempotency key for `clip_render`
- `pending_render?: boolean` — true between Render-click and worker completion

Plus `edits_log?: { at, by, fields }[]` at the top level for an audit trail of who-touched-what.

**§2.3 rendered_short_clip.payload (additions).** The `clip_render` worker now copies the plan's editorial fields (`title`, `description`, `tags`, `styling`, `publish_options`) into the rendered row at render time, plus its own `render_rev` (mirrors plan) and `pending_render: false`. Carrying these means dispatch + UI readers don't have to traverse plan → rendered every read.

**§6 clip_render.ts switches from INSERT to UPSERT.** Previously each render inserted a new `rendered_short_clip` row, which would have stranded operator edits and accumulated orphan rows on re-render. Now it looks up the existing row by `(packageId, type, payload.plan_asset_id, payload.clip_index)` and either updates in place OR inserts when no row exists. The `render_rev` check makes the worker idempotent: if the rendered row's `render_rev >= plan render_rev` (with a non-zero floor), the worker logs "skip" and returns. Defensive word-snap runs on the effective trim before ffmpeg `-ss`.

**§5 word_timestamps surfaced to UI.** MLX Whisper already emits `segments[].words[]` to `transcript.json`; the package page now extracts these via `src/lib/word-snap.ts::flattenTranscriptWords` and passes them to the editor for trim snapping + transcript-panel highlighting + ASS subtitle generation.

**§5.6 subtitle styling.** The render pipeline supports 6 ASS-emitted animation styles (Word Highlight · Pop · Single Word · Typewriter · Motion · Banner). All emit via `src/lib/ass-subtitles.ts` — a new module that converts MLX word timings + a styling block into a libass-compatible `.ass` file (V4+ Styles + Events). ffmpeg's `subtitles=` filter consumes it identically to the legacy VTT path. The previous VTT emitter remains for back-compat with v1 plans that pre-date `styling`.

**§9 dispatch routing.** `rendered_short_clip` continues to route through Zernio (one POST hits TikTok + Instagram + YouTube Shorts simultaneously). The worker now reads `payload.publish_options`:
- `platforms` toggles filter the candidate Zernio networks (operator can opt out of one network per clip).
- `privacy === 'schedule'` + `publish_at` → passed through to Zernio's `createPost.scheduledFor`.
- Other privacy values are platform-controlled (the Zernio SDK surface today doesn't expose per-platform privacy; operator manages after publish).

YouTube Direct path for Shorts (uploading per-clip via the YT Data API rather than Zernio) is deferred — would require firing two dispatches per asset since Zernio still handles TikTok/Instagram in the same submission.

**Editor route + UI files (new).** `src/app/packages/[id]/shorts/[clipIndex]/page.tsx` (server) → `src/components/studio/shorts/ShortsEditor.tsx` (client) → `Timeline.tsx` · `TranscriptPanel.tsx` · `PreviewPlayer.tsx` · `SubtitleStylePanel.tsx` · `ClipPublishOptions.tsx`. Plus a new `src/components/ui/Modal.tsx` primitive (first modal in the codebase: portal + backdrop + Escape + body scroll lock). The Studio tab branches on `platform === 'shorts'` to render `<ShortsList>` (new) in place of the generic `PlatformAssets`. Server actions: `src/server-actions/clip-edit.ts` exports `saveClipEdits` · `renderClip` · `setClipPublishOptions` · `deleteClip`.

**Tests.** `tests/word-snap.test.ts` (15) — binary search edge cases, snap window respect, tie-break, flatten edge cases. `tests/ass-subtitles.test.ts` (16) — colour reversal (`#RRGGBB → &H00BBGGRR`), karaoke `\k` durations, banner BorderStyle 4, all 6 animation tag emission, ASS time format, brace escaping. All pure-function coverage; integration verified end-to-end via the live editor.

---

## Addendum (2026-05-28) — OAuth state, runtime route hydration, and rendered clip immutability

This addendum codifies the fixes from review issues #22-#27.

**Contract file is tracked.** `docs/channelhelm-technical-contract-v1.md` is the repository source of truth and must remain committed. `AGENTS.md` and `CLAUDE.md` are allowed to summarize it, but they must not point GitHub reviewers at an ignored local-only file.

**Settings writes and runtime consumers.** `/api/settings` GET/PUT require `Authorization: Bearer $LOCAL_BEARER_TOKEN`. The local dashboard saves through the Server Action `src/server-actions/settings.ts::saveSettingValue`; browser code must not unauthenticated-`fetch` mutable settings. Next.js route handlers that depend on runtime-editable env values call `hydrateRuntimeSettingsForRoute()` before reading `process.env`. This currently applies to upload limits, signed media enforcement, webhooks, YouTube OAuth setup, and any server-rendered UI that displays runtime OAuth readiness.

**YouTube OAuth state.** OAuth `state` is an opaque nonce stored in `youtube_oauth_states`, not a brand id. Rows contain `brand_id`, `redirect_uri`, optional `login_hint`, optional `expected_channel_id`, `expires_at`, and `consumed_at`. Callback handling must consume the nonce exactly once, reject expired/replayed/mismatched redirect states, and only persist tokens after channel verification. If a brand has `youtube_channel_id`, the connected Google account's `channels.list(mine=true)` result must match that channel id before saving the encrypted refresh token.

**Shorts delete semantics.** `short_clip_plan.payload.clips[i]` is never spliced during deletion because rendered assets and dispatch records address clips by `clip_index`. Delete marks the clip with `deleted: true`, `deleted_at`, and `pending_render: false`. Studio list/editor readers hide deleted plan entries. Non-terminal rendered counterparts may be marked rejected/deleted, but `dispatched` and `published` rendered assets are preserved for audit and webhook lifecycle.

**Rendered clip immutability after dispatch.** `rendered_short_clip` and `rendered_long_clip` rows that are `dispatched` or `published` are terminal for byte replacement. `renderClip` refuses to enqueue a new render for them, and `clip_render` re-checks before ffmpeg work so duplicate or stale jobs cannot overwrite the media file behind a published URL. Operators who need a changed clip after publish must create a new plan clip/revision path that results in a distinct rendered asset.
