/**
 * DojoClaw HTTP client. DojoClaw exposes `POST /api/external/stories/syndicate`,
 * which fans the supplied story out to N matched WordPress sites in the
 * network — each gets its own Article rewritten in that site's voice. We
 * call it with our locally-prepared article brief as `sourceText` (a
 * transcript-derived rewrite spec), so DojoClaw skips its Readability fetch
 * and uses our text verbatim. The URL still travels for footer attribution.
 *
 * Settings (editable at /settings, persisted in the `settings` table):
 *   - DOJOCLAW_API_URL  e.g. http://localhost:3001/api/external/stories/syndicate
 *                       (also accepts a host root, in which case the
 *                       /api/external/stories/syndicate path is appended)
 *   - DOJOCLAW_API_KEY  matches DojoClaw's `api_key` Setting (Bearer)
 */

const SYNDICATE_PATH = '/api/external/stories/syndicate';

export type DojoclawSyndicateRequest = {
  storyId: string;            // stable correlation key; "channelhelm:<assetId>" recommended
  headline: string;
  url: string;                // article permalink / source URL (used in attribution footer)
  source: string;             // short source slug, e.g. "channelhelm" or brand.slug
  sourceName: string;         // human-readable, e.g. "Thorsten Meyer AI"
  topic: string;              // ai | tech | business | ai-work | …
  city?: string;              // default "sfo"
  publishedAt?: number;       // unix seconds; default now
  maxSites?: number;          // 1..15, default 5
  /** Pre-extracted rewrite text — transcript + brief + source evidence. When
   *  supplied, DojoClaw skips Readability and rewrites from this directly. */
  sourceText?: string;
};

export type DojoclawSyndicateResponse = {
  storyId: string;
  count: number;
  status: 'queued' | 'exists' | 'failed';
  sites: Array<{
    articleId: number;
    siteId: number;
    siteName: string;
    confidence: 'high' | 'medium' | 'low';
  }>;
};

function resolveSyndicateUrl(): string {
  const raw = (process.env.DOJOCLAW_API_URL ?? '').trim();
  if (!raw) throw new Error('dojoclaw: DOJOCLAW_API_URL not set (configure at /settings)');
  return raw.includes(SYNDICATE_PATH) ? raw : raw.replace(/\/+$/, '') + SYNDICATE_PATH;
}

/**
 * Send a story to DojoClaw for network-wide syndication. Returns the per-site
 * fan-out result. Idempotent on `storyId` (dedupe returns status='exists').
 */
export async function syndicateStory(
  req: DojoclawSyndicateRequest,
): Promise<DojoclawSyndicateResponse> {
  const key = (process.env.DOJOCLAW_API_KEY ?? '').trim();
  if (!key) {
    throw new Error('dojoclaw: DOJOCLAW_API_KEY not set (configure at /settings)');
  }
  const body = {
    city: 'sfo',
    publishedAt: Math.floor(Date.now() / 1000),
    maxSites: 5,
    ...req,
  };
  const res = await fetch(resolveSyndicateUrl(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const tail = (await res.text().catch(() => '')).slice(0, 500);
    throw new Error(`dojoclaw: ${res.status} ${res.statusText} ${tail}`);
  }
  return (await res.json()) as DojoclawSyndicateResponse;
}

// ─── Article-brief mapping ─────────────────────────────────────────────
//
// ChannelHelm's `article_brief` payload is a rich spec (working_title, hook,
// thesis, argument_outline, source_evidence, tone_notes, …) per
// prompts/article_brief.v1.md. DojoClaw's rewrite is best driven by this
// full spec as `sourceText`. The helper here flattens the brief into the
// labeled multi-line block DojoClaw expects.

export type ArticleBrief = {
  working_title?: string;
  hook?: string;
  thesis?: string;
  argument_outline?: string[] | string;
  source_evidence?: Array<string | { quote?: string; moment?: string }> | string;
  tone_notes?: string;
  estimated_length?: string;
  [k: string]: unknown;
};

export function formatBriefAsSourceText(
  brief: ArticleBrief,
  opts?: { brandName?: string; voiceProfile?: unknown },
): string {
  const parts: string[] = [];
  if (opts?.brandName) parts.push(`Brand: ${opts.brandName}`);
  if (brief.working_title) parts.push(`Working title: ${brief.working_title}`);
  if (brief.hook) parts.push(`Hook:\n${brief.hook}`);
  if (brief.thesis) parts.push(`Thesis:\n${brief.thesis}`);
  if (brief.argument_outline) {
    const arr = Array.isArray(brief.argument_outline)
      ? brief.argument_outline
      : String(brief.argument_outline).split(/\n+/);
    parts.push(
      'Argument outline:\n' +
        arr.map((b, i) => `  ${i + 1}. ${String(b).trim()}`).join('\n'),
    );
  }
  if (brief.source_evidence) {
    const arr = Array.isArray(brief.source_evidence)
      ? brief.source_evidence
      : String(brief.source_evidence).split(/\n+/);
    parts.push(
      'Source evidence:\n' +
        arr
          .map((e) => {
            if (typeof e === 'string') return `  - ${e.trim()}`;
            const q = e.quote ?? e.moment ?? JSON.stringify(e);
            return `  - ${q}`;
          })
          .join('\n'),
    );
  }
  if (brief.tone_notes) parts.push(`Tone notes:\n${brief.tone_notes}`);
  if (brief.estimated_length) parts.push(`Target length: ${brief.estimated_length}`);
  if (opts?.voiceProfile) {
    try {
      parts.push(`Voice profile (JSON):\n${JSON.stringify(opts.voiceProfile)}`);
    } catch {
      /* skip if not stringifiable */
    }
  }
  return parts.join('\n\n');
}

// ─── Back-compat shim ──────────────────────────────────────────────────
// Old call sites used `submitArticleBrief({brief_id, brand_slug, ...})`. The
// new dispatch flow (workers/kinds/dispatch.ts) calls `syndicateStory()`
// directly. This wrapper stays only so anything still importing the old
// name keeps compiling; it adapts to the new endpoint by mapping what it can.

export type DojoclawArticleRequest = {
  brief_id: string;
  brand_slug: string;
  package_id: string;
  asset_id: string;
  brief: ArticleBrief;
  callback_url: string;
  /** Optional fields supplied by the new dispatch flow. */
  brand_name?: string;
  source_url?: string;
  topic?: string;
  max_sites?: number;
};
export type DojoclawArticleResponse = {
  dojoclaw_job_id: string;
  status?: 'queued' | 'running' | 'done';
};

/** @deprecated use {@link syndicateStory} directly */
export async function submitArticleBrief(
  req: DojoclawArticleRequest,
): Promise<DojoclawArticleResponse> {
  const headline =
    req.brief.working_title ??
    (req.brief as { headline?: unknown }).headline?.toString() ??
    `Brief ${req.brief_id}`;
  const sourceText = formatBriefAsSourceText(req.brief, { brandName: req.brand_name });
  const res = await syndicateStory({
    storyId: `channelhelm:${req.asset_id}`,
    headline: String(headline),
    url: req.source_url ?? `https://channelhelm.local/briefs/${req.asset_id}`,
    source: req.brand_slug,
    sourceName: req.brand_name ?? req.brand_slug,
    topic: req.topic ?? 'tech',
    maxSites: req.max_sites ?? 5,
    sourceText,
  });
  return {
    dojoclaw_job_id: res.storyId,
    status: res.status === 'queued' ? 'queued' : res.status === 'exists' ? 'done' : 'queued',
  };
}
