# Content Studio flow — design

**Date:** 2026-05-21
**Status:** approved-pending-review
**Author:** Thorsten + Claude

## Goal

Replace the current minimal dashboard with an upload-first **Content Studio**:
drop or link a video → the pipeline produces derivatives → a polished
per-platform detail view (modeled on the operator's reference screenshots)
lets the operator review, edit, regenerate, and publish.

## Scope of this pass

In:
- Upload-first home `/` (paste URL **and** drag-drop file upload).
- `uploaded_video` ingest support (ffmpeg-only, no yt-dlp).
- Studio detail view replacing `/packages/[id]`, **YouTube tab fully built**.
- Scored titles + scored tags (LLM emits 0–100).
- Per-section interactive Regenerate.
- `/media/*` route to serve local media (video + thumbnails).
- Platform tab bar listing all 15 LATE/Zernio platforms; non-YouTube tabs
  render existing assets + a LATE Publish action.

Out (later passes):
- Net-new generators/prompts for each non-YouTube platform.
- A dedicated `threads_post` / `instagram_caption` etc. asset type per network.
- Real YouTube Data API OAuth (publish goes through LATE, which supports
  YouTube video + shorts).

## Naming reconciliation: LATE = Zernio

getlate.dev rebranded to **zernio.com**. The contract's "Zernio" external
social API and the operator's "LATE" are the same product. The existing
`workers/integrations/zernio.ts` is the LATE integration; this pass widens
its platform list and dispatch routing. No new integration module.

**15 supported platforms** (docs.zernio.com/platforms): Twitter/X, Instagram,
Facebook, LinkedIn, TikTok, YouTube, Pinterest, Reddit, Bluesky, Threads,
Google Business, Telegram, Snapchat, WhatsApp, Discord.

## Deployment

Single Mac now (Next.js + Postgres + workers + LM Studio co-located), split
across the fleet later. No architecture change: `LM_STUDIO_*` and DojoClaw/
LATE host env vars default to localhost and repoint via the launchd plists
(infra/launchd) when roles move to other Macs.

## Architecture

### 1. Upload-first home (`/`)

- `src/app/page.tsx` → `<UploadDashboard>` (client island) over a server
  component that lists recent packages as cards beneath.
- Brand selector (defaults to first active brand; CTA to `/brands/new` if none).
- Two inputs in one drop zone:
  - **URL paste** → `POST /api/sources` (kind `youtube_url`) + package +
    `enqueue('ingest')` — existing path.
  - **File drop** → `POST /api/uploads` (multipart, streamed to disk):
    writes `MEDIA_ROOT/{brand_slug}/{src_id}/original.{ext}`, creates a
    `uploaded_video` source with `local_media_path` preset, creates the
    package, enqueues `ingest`.
- `/api/uploads` is a Node route handler reading `req.body` as a stream
  (bypasses the small Server-Action body cap). Bearer-auth like other API
  routes.

### 2. `uploaded_video` ingest branch

`workers/kinds/ingest.ts`: when `source.kind === 'uploaded_video'`, skip
yt-dlp (the file is already at `local_media_path/original.<ext>`), then run
the same ffmpeg audio-extract + scene-detect + ffprobe-duration path. Title
falls back to the uploaded filename.

### 3. `/media/*` static route

`src/app/api/media/[...path]/route.ts` streams files from under
`MEDIA_ROOT` with path-traversal guards (resolve + ensure the resolved path
stays within `MEDIA_ROOT`). Range-request support so the `<video>` element
can seek. Bearer-auth optional for local use; gated behind a check that the
path is inside MEDIA_ROOT. (Cloudflare Tunnel later serves this via nginx in
production; this route is the local-dev equivalent.)

### 4. Studio detail view (`/packages/[id]`)

Server component loads package + assets + intelligence; a client
`<Studio>` shell renders:
- Header: selected title, **Retry** (re-enqueue ingest), **Delete**
  (cascade delete package + assets + media dir).
- Horizontally-scrollable **platform pill bar**: `YouTube · Shorts · Clips ·
  Blog` + the 15 LATE networks. Active tab in state.
- **YouTube tab** (fully built):
  - `<VideoPlayer>` from `/api/media/...original.mp4`.
  - Action row: Download Video, Download YouTube Metadata (.txt/.json built
    from the assets), Publish to YouTube (→ LATE).
  - `<ThumbnailStrip>`: existing `thumbnail_concept` assets + **Generate AI
    Thumbnails** (enqueues `thumbnail_concepts`) + Faces dropdown (Auto/On/Off
    passed through to the worker payload; worker may ignore for now).
  - `<TitlesCard>`: 5 scored candidates, selected one highlighted, inline
    edit, char-count vs 70, Copy selected, Regenerate (whole set) + per-title
    regenerate-one.
  - `<DescriptionCard>`: text + chapters + hashtags, Edit / Copy / Regenerate.
  - `<TagsCard>`: scored pills, Edit / Copy / Regenerate.
  - `<TranscriptCard>`: read-only text + Copy.
- **Other tabs**: render the mapped existing asset(s) with Copy + Regenerate
  where a generator exists, and a LATE **Publish** button; Threads/Instagram/
  etc. with no asset yet show "Generate via the pipeline / coming soon".

Tab → asset mapping:
| Tab | Asset(s) |
|---|---|
| YouTube | youtube_title_set, youtube_description, youtube_chapters, youtube_tags, thumbnail_concept, transcript |
| Shorts | short_clip_plan, rendered_short_clip |
| Clips | rendered_short_clip (longer), clip plans |
| Blog | article_brief, newsletter_summary |
| X | x_post, x_thread |
| LinkedIn | linkedin_post |
| Threads/Instagram/Facebook/TikTok/Pinterest/Reddit/Bluesky/Google Business/Telegram/Snapchat/WhatsApp/Discord | (none yet) → "coming soon" + reuse linkedin/x copy as a starting draft to publish |

### 5. Scoring

`youtube_title_set` payload: `{ titles: [{ text: string, score: number }] }`
(0–100). `youtube_tags`: `{ tags: [{ text: string, score: number }] }`.
Prompts updated to emit scores. §2.3 of the contract updated to document the
new shapes. UI reads `{text, score}`; a migration-free read path tolerates
the old `string[]` shape (treat as score `null`) so existing rows don't break.

### 6. Interactive Regenerate — the carve-out

Extract `workers/lib/generate.ts :: generateAssetContent(assetType, pkg,
brand)` that returns `{ payload, provenance }`. **Both** consumers call it:
- `workers/kinds/generate_asset.ts` (bulk pipeline, unchanged behavior).
- `src/server-actions/regenerate.ts :: regenerateAsset(assetId)` — a
  synchronous Server Action that calls `generateAssetContent`, updates the
  asset row, `revalidatePath`s the studio page.

**Deliberate, documented deviation** from "no LLM in Server Actions / app
enqueues, workers do": interactive single-item regeneration is a bounded,
text-only LLM call (~10–30 s) where enqueue+poll would force a "is a worker
running?" dependency that ruins the studio UX. The heavy/bulk path stays on
the queue. Noted in CLAUDE.md "What NOT to do" as an explicit exception.

### 7. LATE dispatch widening

`workers/integrations/zernio.ts`: `networkFor()` / `createPost()` accept all
15 platforms. `workers/kinds/dispatch.ts` routing table maps each asset type
to its default LATE network; the studio Publish button enqueues `dispatch`
for the relevant asset (existing approval→dispatch path).

## Data flow

```
home upload (url|file)
  → POST /api/sources|/api/uploads  → source + package + enqueue(ingest)
  → ingest (yt-dlp|file) → transcribe → analyze_visual → fuse
  → analyze_intelligence → generate_asset×N (+ scores) → thumbnail_concepts
  → studio detail view renders assets
       Regenerate → server action → generateAssetContent → update row
       Publish    → enqueue(dispatch) → LATE/Zernio
```

## Components (new)

- `src/components/studio/UploadDashboard.tsx` (client)
- `src/components/studio/Studio.tsx` (client shell + tab state)
- `src/components/studio/VideoPlayer.tsx`
- `src/components/studio/ThumbnailStrip.tsx`
- `src/components/studio/TitlesCard.tsx`
- `src/components/studio/DescriptionCard.tsx`
- `src/components/studio/TagsCard.tsx`
- `src/components/studio/TranscriptCard.tsx`
- `src/components/studio/PlatformTabs.tsx`
- `src/server-actions/regenerate.ts`, `studio.ts` (retry/delete/select-title)
- `src/app/api/uploads/route.ts`, `src/app/api/media/[...path]/route.ts`

## Error handling

- Upload: reject non-video MIME / oversize (configurable cap, default 2 GB);
  clean up the partial file on failure.
- Media route: 404 on missing, 403 on path-escape, 206 on range.
- Regenerate: surface LLM/JSON-parse failures inline in the card; the row is
  only updated on success (no partial writes).
- Tolerant reads for the old title/tag payload shape.

## Testing

- vitest: `networkFor()` covers all 15 platforms; title/tag payload
  tolerant-read helper; media-path traversal guard.
- smoke: `smoke-upload.sh` (POST a local file → ingest → assets) and extend
  `smoke-pipeline.sh` to assert scored title/tag shape.
- Manual: dev server, drop a file + paste a URL, walk the YouTube tab,
  Regenerate each section, Publish (no-key path returns the friendly error).

## Phasing within this pass

1. `/media` route + VideoPlayer (unblocks the visual).
2. Upload (`/api/uploads`) + `uploaded_video` ingest branch.
3. `generateAssetContent` extraction + regenerate server action.
4. Scoring in the two prompts + tolerant reads.
5. Studio shell + YouTube cards.
6. Platform tabs + LATE widening + Publish wiring.
7. Smokes + tests + docs (CLAUDE.md exception, §2.3 payloads).
