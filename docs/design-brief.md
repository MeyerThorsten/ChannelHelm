# ChannelHelm — Design Brief

A brief for a fresh visual/UX design of ChannelHelm. It describes the product,
who uses it, every screen as it exists today, the current (utilitarian) design
system, the core flows, the hard constraints, and where a new design should
push. Hand this to a design tool/agent to propose a new direction.

---

## 1. What ChannelHelm is

ChannelHelm is a **local-first video-to-publishing command center**. A creator
drops in a video (a file or a YouTube/podcast/webinar URL); ChannelHelm
"understands" it through a four-layer pipeline (audio → visual → fusion →
intelligence) and produces a canonical **Publishing Package**: every derivative
asset needed to publish across platforms — YouTube title/description/tags/
chapters/thumbnails, short-clip plans, blog briefs, and social posts for 15
networks. The operator reviews and edits each asset, approves, and ChannelHelm
routes them out (YouTube/social via an external API; editorial to a local
service).

It runs on the creator's own Macs (local-first), not a cloud SaaS. The only
external dependency is the social-publishing API.

One sentence: **"Drop a video, get a complete, on-brand publishing kit you can
review and ship."**

## 2. Who uses it

A single power-user operator (a creator/editor) running their own channel(s).
- Comfortable with technical tools, but wants the *content review* experience to
  feel fast and confident, not like a database admin panel.
- Works across **multiple brands** (each = a channel with its own voice,
  YouTube channel, website, publishing defaults).
- Lives in long review sessions: scanning generated options, tweaking copy,
  regenerating, approving.

## 3. The core object: a "Package"

Everything centers on a **Package** = one source video + all its understanding
+ all its generated **Assets**. A package moves through statuses:
`draft → analyzing → analyzed → ready_for_review → approved → dispatching →
scheduled → published` (plus `rejected` / `failed`). Each **Asset**
(e.g. `youtube_title_set`, `youtube_description`, `rendered_short_clip`) has its
own status and a provenance trail (which model/provider produced it).

## 4. Information architecture (current routes)

| Route | Purpose | Priority |
|---|---|---|
| `/` | **Home** — upload-first dashboard + recent packages | hero |
| `/packages/[id]` | **Content Studio** — review/edit/approve all assets | hero |
| `/brands`, `/brands/[id]`, `/brands/new` | Brand management | secondary |
| `/providers`, `/providers/[id]` | LLM provider config (OpenAI/Anthropic/LM Studio/Ollama/OpenRouter/OpenClaw/Codex) | secondary |
| `/jobs` | Job-queue inspector (pipeline progress) | secondary |
| `/webhooks` | Inbound webhook event log | utility |
| `/voice-examples` | Brand-voice training examples | utility |
| `/settings` | Tokens / config | utility |

A persistent top **Nav** bar spans all pages: `ChannelHelm` wordmark + links
(New / Packages · Brands · Jobs · Webhooks · Voice · Providers · Settings).

## 5. The two hero screens (current state)

### 5a. Home `/` — upload-first dashboard

```
┌───────────────────────────────────────────────────────────┐
│ Nav: ChannelHelm   New/Packages  Brands  Jobs … Providers   │
├───────────────────────────────────────────────────────────┤
│  New video                                                  │
│  Drop a file or paste a link to start the pipeline.         │
│                                                             │
│  ┌─ card ──────────────────────────────────────────────┐   │
│  │ [Brand ▾ (auto-detected for links)]  [Profile ▾]     │   │
│  │ ┌───────────────────────────────────────────────┐   │   │
│  │ │              ⬆                                  │   │   │
│  │ │   Drop a video here, or click to choose        │   │   │
│  │ │   mp4 · mov · webm · m4v · mkv                  │   │   │
│  │ └───────────────────────────────────────────────┘   │   │
│  │ [ …or paste a YouTube / video URL    ] [Ingest link] │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  RECENT PACKAGES (24)                                       │
│  ┌─ row ───────────────────────────────── [status pill] ┐  │
│  │ The Policy Menu — Choosing Our Path…                  │  │
│  │ thorsten-meyer-ai · standard_audio_visual · youtube   │  │
│  └───────────────────────────────────────────────────────┘ │
│  … more rows …                                              │
└───────────────────────────────────────────────────────────┘
```

Behavior: pasting a YouTube link **auto-discovers the brand** from the channel
(no manual pick needed); file uploads use the selected brand. Submitting creates
a package and navigates to the Studio.

### 5b. Content Studio `/packages/[id]` — the heart of the product

This is where the operator spends their time. Today it is a long vertical scroll
of cards under a horizontal platform tab bar.

```
┌───────────────────────────────────────────────────────────┐
│ ← all packages                                              │
│ The Policy Menu — Choosing Our Path to a Post-Labor Future  │
│ Thorsten Meyer AI · standard_audio_visual · [draft]   [↺ Retry] [🗑 Delete]
│ ───────────────────────────────────────────────────────── │
│ [▶ YouTube][✂ Shorts][▦ Clips][📄 Blog][𝕏 X][in LinkedIn]  │
│ [◎ Instagram][f Facebook][♪ TikTok][@ Threads] … (18 tabs) │
│                                                             │
│                       [⬇ Download Video] [⬇ Download Metadata]
│  ┌─ video player ──────────────────────────────────────┐   │
│  │            (16:9 player, scrubber)                   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ card ──────────────────────────────────────────────┐   │
│  │         ✦ Generate AI Thumbnails    Faces:[Auto ▾]   │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ 📝 Titles ─────────────────────────────────────────┐   │
│  │ ○ Why the AI Race is No Longer About Chips    95/100 │   │
│  │ ● UBI vs UBC: The AI Economy Needs Both       92/100 │   │
│  │   [Copy selected] [✦ Regenerate]  (inline edit, /70) │   │
│  └─────────────────────────────────────────────────────┘   │
│  ┌─ 📄 Description ─┐  ┌─ 🏷 Tags (scored pills) ─┐         │
│  ┌─ 🧵 Transcript (collapsible, Copy) ─────────────────┐    │
└───────────────────────────────────────────────────────────┘
```

- **Platform tabs**: YouTube · Shorts · Clips · Blog + 14 social networks. YouTube
  is fully built; other tabs show their mapped assets or a "coming soon" panel.
- **YouTube tab cards**: video player; "Generate AI Thumbnails"; **Titles**
  (scored 0-100, click-to-select, inline edit, char-count vs 70, copy,
  regenerate); **Description** (now includes chapters + hashtags; edit/copy/
  regenerate); **Tags** (scored pills); **Transcript** (copy, expand).
- Empty sections show a **Generate** button (generate that section on demand
  from the transcript).
- Every card action can fail; errors surface inline under the control.

## 6. Secondary screens (current state, brief)

- **Brands**: list + a long form (name, slug auto-derived, website, YouTube
  channel id [accepts @handle], voice profile, Zernio/DojoClaw routing,
  processing-profile default, approval/auto-dispatch lists). A "Normalize slug"
  banner appears when needed.
- **Providers**: list of configured LLM providers (name · type · model · purpose
  · base url, "default"/"disabled" chips, Test/Edit/Delete) + an add/edit form
  with **Quick Preset** buttons, a **Fetch Models** dropdown, and a special
  **Codex CLI** type (hides URL/key, shows an auth note).
- **Jobs**: a table of queue jobs (kind, status, attempts, error) — pipeline
  progress lives here today.
- **Webhooks / Voice / Settings**: simple lists/forms.

## 7. Current visual design system (honest assessment)

- **Stack**: Next.js App Router + Tailwind **v4** (CSS `@theme`, no config file)
  + shadcn/ui primitives. Designs should stay implementable in Tailwind classes.
- **Palette**: near-monochrome **zinc** grays; **sky** blue as the only accent;
  semantic status colors defined as CSS vars (`--color-status-*`: draft gray,
  analyzing teal, ready amber, approved/published blue/green, failed red).
- **Surface**: light `#fafafa` bg / dark `#0a0a0a`; white (or zinc-900) cards
  with `border-zinc-200/800`, `rounded-lg/xl/2xl`, subtle `shadow-sm`.
- **Type**: system UI sans (`ui-sans-serif, system-ui`); no custom/brand font.
- **Dark mode**: supported throughout via `dark:` + `prefers-color-scheme`.
- **Components**: SectionCard chrome, status pills, async action buttons
  (pending + inline error), copy buttons, scored pills, drop zone.
- **Density**: comfortable, max-width containers (`max-w-2xl`–`max-w-6xl`),
  desktop-first.

**Character today: clean but generic and tool-like.** It reads as a competent
internal admin panel, not as a confident product with its own identity. There is
no distinctive visual voice, no real sense of "studio," and pipeline
state/progress is under-communicated.

## 8. Core flows

1. **Ingest** — Home → drop file / paste link → (brand auto-discovered) →
   package created → navigate to Studio (status `draft`/`analyzing`).
2. **Pipeline (background workers)** — ingest → transcribe + analyze-visual →
   fuse → analyze-intelligence → generate assets (titles/description/tags/
   clips/social) + thumbnails. Can take minutes; visual stage is the slow part.
3. **Review** — in the Studio, per platform/section: read scored options, select,
   edit inline, regenerate, or generate-on-demand. Watch sections fill in as the
   pipeline completes.
4. **Approve & publish** — approve assets → dispatch to YouTube/social (external
   API) or editorial (local service). Track status to `published`.

## 9. Domain vocabulary (use these terms)

Package · Source · Asset · Brand · Processing Profile (`fast_audio_only` /
`standard_audio_visual` / `premium_multimodal`) · Provenance · Scene log ·
Intelligence/Analysis · Dispatch · Provider.

## 10. Constraints (must respect)

- **Desktop-first**, single power user. (Mobile is not a priority.)
- **Local-first**; no cloud-SaaS framing, no marketing chrome.
- Must be implementable in **Tailwind v4 + shadcn/ui** (no heavy bespoke CSS/JS).
- **Dark + light** both first-class.
- Keep the **status color semantics** and the platform/asset vocabulary.
- Long-running work is asynchronous — the UI must represent "in progress" and
  "partially ready" states gracefully (assets appear over time).

## 11. What we want from a new design (the ask)

Make ChannelHelm feel like a **content studio**, not an admin panel. Specifically:

1. **A distinctive identity** — a real visual voice (color, type, spacing,
   motion) that still works as a dense pro tool.
2. **Studio screen rethink** — the per-package review is the product. Today it's
   one long scroll. Explore: a two-pane layout (video/context fixed, assets
   scrollable), better platform switching, side-by-side option comparison,
   clearer "selected vs alternatives," and a confident approve/publish moment.
3. **Pipeline status, surfaced** — show a package's progress (which of the 4
   layers are done, which assets are still generating) inline, so the operator
   isn't checking a jobs table. Treat "partially ready" as a first-class state.
4. **The ingest moment** — make Home feel like the start of something, with
   clear feedback that brand auto-detection happened.
5. **Scored content, legible** — titles/tags carry 0-100 scores; design how
   scores, selection, char-limits, and per-section regenerate read at a glance.
6. **Multi-brand & multi-platform** — make the current brand and the 15+ target
   platforms feel navigable, not like 18 cramped tabs.
7. **Consistency** — one component language across Studio, Brands, Providers,
   Jobs.

## 12. Open questions for the designer

- Should the Studio be tab-per-platform (today) or a single canvas with platform
  filters/grouping?
- How prominent should the raw video + transcript be vs. the generated assets?
- How to represent a package that is 60% generated (some assets ready, some
  pending, some failed) at a glance?
- Light or dark as the primary brand surface?

---

### Reference: the quality bar for generated copy

A target YouTube description ChannelHelm now produces (hook → body → chapters →
CTA → hashtags) — the design should give this kind of structured, multi-section
content room to breathe:

> For years, the global AI race was seen as a battle of silicon… ⚡
> [body paragraphs] …
> Chapters
> 0:00 The New Binding Constraint on AI
> 1:48 The Gigawatt Scale Reality …
> If you found this helpful, like + subscribe… 🚀
> #AI #TechPolicy #Energy #FutureTech
