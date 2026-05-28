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
  storyId: string; // stable correlation key; "channelhelm:<assetId>" recommended
  headline: string;
  url: string; // article permalink / source URL (used in attribution footer)
  source: string; // short source slug, e.g. "channelhelm" or brand.slug
  sourceName: string; // human-readable, e.g. "Thorsten Meyer AI"
  topic: string; // ai | tech | business | ai-work | …
  city?: string; // default "sfo"
  publishedAt?: number; // unix seconds; default now
  maxSites?: number; // 1..15, default 5
  /** Pre-extracted rewrite text — transcript + brief + source evidence. When
   *  supplied, DojoClaw skips Readability and rewrites from this directly. */
  sourceText?: string;
  /** Where DojoClaw POSTs `article.published` events once each fan-out
   *  article reaches WordPress. Body is HMAC-signed with the shared
   *  webhook_secret; receiver verifies via DOJOCLAW_WEBHOOK_SECRET. */
  callbackUrl?: string;
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
      `Argument outline:\n${arr.map((b, i) => `  ${i + 1}. ${String(b).trim()}`).join('\n')}`,
    );
  }
  if (brief.source_evidence) {
    const arr = Array.isArray(brief.source_evidence)
      ? brief.source_evidence
      : String(brief.source_evidence).split(/\n+/);
    parts.push(
      `Source evidence:\n${arr
        .map((e) => {
          if (typeof e === 'string') return `  - ${e.trim()}`;
          const q = e.quote ?? e.moment ?? JSON.stringify(e);
          return `  - ${q}`;
        })
        .join('\n')}`,
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

// ─── Article analytics ────────────────────────────────────────────────
//
// NOTE: This endpoint does not yet exist in DojoClaw as of ChannelHelm v1.3.
// It is designed here as a sensible REST path; a DojoClaw-side implementation
// would add GET /api/external/stories/:storyId/analytics returning the shape
// below. Until then, this function degrades gracefully — returning null on any
// 404, network refusal, or non-200 response so collect_signal skips cleanly.
//
// DEFERRED: Google Search Console (GSC) position + impression metrics are a
// follow-up requiring Search Console OAuth. They will plug into the same
// DojoclawArticleAnalytics shape (extra optional fields) once available.

const ANALYTICS_PATH_PREFIX = '/api/external/stories';

function resolveBaseUrl(): string {
  const raw = (process.env.DOJOCLAW_API_URL ?? '').trim();
  if (!raw) throw new Error('dojoclaw: DOJOCLAW_API_URL not set (configure at /settings)');
  // Strip known path suffixes so we get back to the host root.
  return raw.replace(/\/api\/external\/stories\/syndicate\/?$/, '').replace(/\/+$/, '');
}

export type DojoclawArticleAnalytics = {
  /** Total page views for this story across syndicated sites. */
  pageViews: number;
  /** Number of readers who reached the end / scrolled ≥80 % of the article. */
  reads?: number;
  /** Average time on page in seconds across all visits. */
  avgTimeOnPage?: number;
  /** ISO-8601 timestamp when DojoClaw last computed these aggregates. */
  lastSampledAt: string;
};

/**
 * Fetch per-article analytics from DojoClaw for a syndicated story.
 *
 * Calls: GET {DOJOCLAW_BASE}/api/external/stories/{storyId}/analytics
 * Auth:  Bearer DOJOCLAW_API_KEY (same key as syndicateStory)
 *
 * Returns `null` (never throws) when:
 *   - DOJOCLAW_API_URL / DOJOCLAW_API_KEY are unset
 *   - The endpoint returns 404 (not implemented server-side yet)
 *   - Connection is refused or times out (DojoClaw offline)
 *   - Any other non-200 HTTP status
 *
 * This graceful-null contract lets collect_signal skip cleanly without
 * failing the job while DojoClaw has no analytics endpoint server-side.
 */
export async function fetchArticleAnalytics(
  storyId: string,
): Promise<DojoclawArticleAnalytics | null> {
  const key = (process.env.DOJOCLAW_API_KEY ?? '').trim();
  let baseUrl: string;
  try {
    baseUrl = resolveBaseUrl();
  } catch {
    // DOJOCLAW_API_URL not configured — nothing to fetch.
    return null;
  }
  if (!key) return null;

  const url = `${baseUrl}${ANALYTICS_PATH_PREFIX}/${encodeURIComponent(storyId)}/analytics`;
  try {
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${key}` },
      // Short timeout — DojoClaw runs locally; if it's not responding in 5 s
      // we don't want to hold up the recurring worker.
      signal: AbortSignal.timeout(5_000),
    });
    if (res.status === 404) {
      // Endpoint not implemented server-side yet — expected during ramp-up.
      return null;
    }
    if (!res.ok) {
      console.warn(`[dojoclaw] analytics ${storyId}: ${res.status} ${res.statusText}`);
      return null;
    }
    const data = (await res.json()) as Partial<DojoclawArticleAnalytics>;
    if (typeof data.pageViews !== 'number') {
      console.warn(`[dojoclaw] analytics ${storyId}: unexpected shape`, data);
      return null;
    }
    return {
      pageViews: data.pageViews,
      reads: data.reads,
      avgTimeOnPage: data.avgTimeOnPage,
      lastSampledAt: data.lastSampledAt ?? new Date().toISOString(),
    };
  } catch (err) {
    // Network error (ECONNREFUSED, timeout, etc.) — DojoClaw may be offline.
    console.warn(`[dojoclaw] analytics ${storyId}: connection error — ${(err as Error).message}`);
    return null;
  }
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
