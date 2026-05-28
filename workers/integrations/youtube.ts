/**
 * YouTube Data API v3 integration. Operator goes through Google OAuth once
 * per brand at `/api/youtube/oauth/start` — we receive a refresh_token,
 * encrypt it via secret-box, store it on `brands.youtube_oauth`. The
 * dispatch worker exchanges the refresh_token for a short-lived access_token
 * before each upload, then streams `original.mp4` to YouTube's resumable
 * upload endpoint.
 *
 * Scopes required:
 *   youtube.upload         — for videos.insert
 *   youtube                — for thumbnails.set, videos.update (A/B rotation), channel listing
 *   yt-analytics.readonly  — for the YouTube Analytics API (A/B winner decision)
 *
 * NOTE: yt-analytics.readonly was added in v1.5. Brands connected before then
 * must reconnect to grant it; `youtubeConnectionStatus().analytics` reports
 * whether the saved grant already covers it.
 *
 * Quota: each upload is 1,600 units; default 10,000/day = ~6 uploads. Bump
 * via the GCP console if you scale.
 */

import { createReadStream, statSync } from 'node:fs';
import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { decryptSecret, encryptSecret } from '@/lib/secret-box';
import { eq, sql } from 'drizzle-orm';
import type { OAuth2Client } from 'google-auth-library';
import { google, type youtube_v3 } from 'googleapis';

const YT_ANALYTICS_SCOPE = 'https://www.googleapis.com/auth/yt-analytics.readonly';
const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
  YT_ANALYTICS_SCOPE,
];

/** Get the Google OAuth client configured from /settings (env-hydrated). */
function oauthClient(redirectUri: string): OAuth2Client {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      'Google OAuth client not configured — set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET in /settings.',
    );
  }
  return new google.auth.OAuth2({
    clientId,
    clientSecret,
    redirectUri,
  });
}

/**
 * Step 1 of the OAuth dance — return the Google consent URL with the
 * caller-provided nonce encoded in `state` so the callback can map back.
 *
 * `prompt: 'select_account consent'` is deliberate:
 *  - `select_account` ALWAYS shows the Google account chooser, even when the
 *    browser is already signed in. Without this, a single-signed-in browser
 *    auto-uses that account — wrong outcome when the operator's YouTube
 *    channel lives under a different Google account from the one they happen
 *    to be using right now.
 *  - `consent` forces the scopes consent screen so Google re-issues a
 *    refresh_token (it only emits one on first grant unless re-prompted).
 *
 * `loginHint` (optional) pre-fills the email on the chooser — handy when the
 * operator knows which Google account owns the channel.
 */
export function youtubeAuthUrl(state: string, redirectUri: string, loginHint?: string): string {
  const client = oauthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'select_account consent',
    scope: YT_SCOPES,
    state,
    include_granted_scopes: true,
    ...(loginHint ? { login_hint: loginHint } : {}),
  });
}

/**
 * Step 2 — exchange the auth code for tokens, fetch the channel id/title,
 * and persist (refresh_token encrypted) on the brand row. Idempotent: a
 * subsequent connect overwrites the saved token.
 */
export async function youtubeOauthCallback(
  brandId: string,
  code: string,
  redirectUri: string,
  expectedChannelId?: string | null,
): Promise<{ channelId: string | null; channelTitle: string | null }> {
  const client = oauthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token) {
    throw new Error(
      'Google did not return a refresh_token. Disconnect the app at https://myaccount.google.com/permissions and retry — Google only issues a refresh_token on the first grant.',
    );
  }
  client.setCredentials(tokens);

  // Best-effort: fetch the channel info so the brand UI can show "Connected: <name>"
  let channelId: string | null = null;
  let channelTitle: string | null = null;
  try {
    const yt = google.youtube({ version: 'v3', auth: client });
    const me = await yt.channels.list({ mine: true, part: ['id', 'snippet'] });
    const items = me.data.items ?? [];
    const item = expectedChannelId
      ? (items.find((candidate) => candidate.id === expectedChannelId) ?? items[0])
      : items[0];
    channelId = item?.id ?? null;
    channelTitle = item?.snippet?.title ?? null;
  } catch (err) {
    if (expectedChannelId) {
      throw new Error(
        `Could not verify the connected YouTube channel against expected channel ${expectedChannelId}: ${(err as Error).message}`,
      );
    }
    console.warn('[youtube] channel lookup failed (continuing):', (err as Error).message);
  }

  if (expectedChannelId) {
    if (!channelId) {
      throw new Error(`Could not verify connected YouTube channel ${expectedChannelId}`);
    }
    if (channelId !== expectedChannelId) {
      throw new Error(
        `Connected Google account owns YouTube channel ${channelId}, but brand expects ${expectedChannelId}`,
      );
    }
  }

  const youtubeOauth = {
    refresh_token: encryptSecret(tokens.refresh_token),
    access_token: tokens.access_token ? encryptSecret(tokens.access_token) : undefined,
    access_token_expires_at: tokens.expiry_date
      ? new Date(tokens.expiry_date).toISOString()
      : undefined,
    channel_id: channelId ?? undefined,
    channel_title: channelTitle ?? undefined,
    scope: (tokens.scope ?? YT_SCOPES.join(' ')) as string,
    connected_at: new Date().toISOString(),
  };
  await db
    .update(brands)
    .set({ youtubeOauth, updatedAt: sql`now()` })
    .where(eq(brands.id, brandId));

  return { channelId, channelTitle };
}

/** Clear the saved tokens. The Google-side grant stays revocable at myaccount.google.com. */
export async function youtubeOauthDisconnect(brandId: string): Promise<void> {
  await db
    .update(brands)
    .set({
      youtubeOauth: null,
      youtubeDispatchTarget: 'manual',
      updatedAt: sql`now()`,
    })
    .where(eq(brands.id, brandId));
}

/**
 * Build an OAuth2 client primed with the saved refresh_token for a brand.
 * Returns null when the brand isn't connected. The googleapis client will
 * auto-refresh access_tokens on demand (it just needs the refresh_token).
 */
async function clientFor(brandId: string, redirectUri: string): Promise<OAuth2Client | null> {
  const [row] = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
  if (!row?.youtubeOauth?.refresh_token) return null;
  const client = oauthClient(redirectUri);
  client.setCredentials({
    refresh_token: decryptSecret(row.youtubeOauth.refresh_token),
  });
  return client;
}

export type YoutubeUploadRequest = {
  brandId: string;
  redirectUri: string; // needed to construct the OAuth client — same value used at connect time
  filePath: string;
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string; // see https://developers.google.com/youtube/v3/docs/videoCategories — '22' (People & Blogs) is a safe default
  privacyStatus?: 'private' | 'unlisted' | 'public';
  /**
   * ISO timestamp at which YouTube should auto-flip the video to public.
   * Requires `privacyStatus='private'` (the API enforces this). Caller is
   * responsible for forcing private when scheduling.
   */
  publishAt?: string;
  selfDeclaredMadeForKids?: boolean;
  defaultLanguage?: string;
  thumbnailPath?: string; // optional: separate API call after the video is up
};

export type YoutubeUploadResponse = {
  videoId: string;
  url: string;
  privacy: string;
  uploadBytes: number;
};

/**
 * Resumable upload of a local MP4 to YouTube. Streams the file (no full
 * read into memory). On success returns the video id + canonical youtu.be URL.
 *
 * Quota cost: ~1,600 units. Errors are rethrown as plain Error so the dispatch
 * worker can mark the asset failed with a useful message.
 */
export async function uploadVideo(req: YoutubeUploadRequest): Promise<YoutubeUploadResponse> {
  const client = await clientFor(req.brandId, req.redirectUri);
  if (!client) {
    throw new Error(
      `youtube: brand ${req.brandId} has no YouTube connection. Connect it on /brands/${req.brandId} → "Connect YouTube".`,
    );
  }
  const yt = google.youtube({ version: 'v3', auth: client });
  const stat = statSync(req.filePath);

  const snippet: youtube_v3.Schema$VideoSnippet = {
    title: req.title.slice(0, 100), // YouTube hard limit
    description: req.description.slice(0, 5000),
    tags: req.tags?.slice(0, 30),
    categoryId: req.categoryId ?? '22',
    defaultLanguage: req.defaultLanguage,
  };
  const status: youtube_v3.Schema$VideoStatus = {
    privacyStatus: req.privacyStatus ?? 'private',
    selfDeclaredMadeForKids: req.selfDeclaredMadeForKids ?? false,
    embeddable: true,
    ...(req.publishAt ? { publishAt: req.publishAt } : {}),
  };

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: { snippet, status },
    media: { body: createReadStream(req.filePath) },
  });

  const videoId = res.data.id;
  if (!videoId) {
    throw new Error('youtube: upload completed but no videoId returned');
  }

  // Optional thumbnail. Failure here doesn't unwind the upload — the video
  // is live; the operator can re-upload the thumbnail later.
  if (req.thumbnailPath) {
    try {
      await yt.thumbnails.set({
        videoId,
        media: { body: createReadStream(req.thumbnailPath) },
      });
    } catch (err) {
      console.warn(`[youtube] thumbnail upload failed (video is up): ${(err as Error).message}`);
    }
  }

  return {
    videoId,
    url: `https://youtu.be/${videoId}`,
    privacy: status.privacyStatus ?? 'private',
    uploadBytes: stat.size,
  };
}

/**
 * Apply one A/B variant to a PUBLISHED video: swap the title (videos.update —
 * the API requires the full snippet incl categoryId, so we fetch-then-patch)
 * and/or the thumbnail (thumbnails.set). Either field is optional; a null/empty
 * title leaves the title untouched. Used by the experiment_tick rotation worker.
 */
export async function applyVideoVariant(opts: {
  brandId: string;
  redirectUri: string;
  videoId: string;
  title?: string | null;
  thumbnailPath?: string | null;
}): Promise<void> {
  const client = await clientFor(opts.brandId, opts.redirectUri);
  if (!client) {
    throw new Error(`youtube: brand ${opts.brandId} has no YouTube connection`);
  }
  const yt = google.youtube({ version: 'v3', auth: client });

  if (opts.title?.trim()) {
    const cur = await yt.videos.list({ id: [opts.videoId], part: ['snippet'] });
    const snip = cur.data.items?.[0]?.snippet;
    if (!snip) {
      throw new Error(`youtube: video ${opts.videoId} not found (cannot update title)`);
    }
    await yt.videos.update({
      part: ['snippet'],
      requestBody: {
        id: opts.videoId,
        snippet: {
          title: opts.title.slice(0, 100),
          categoryId: snip.categoryId ?? '22', // categoryId is required on update
          description: snip.description ?? undefined,
          tags: snip.tags ?? undefined,
          defaultLanguage: snip.defaultLanguage ?? undefined,
        },
      },
    });
  }

  if (opts.thumbnailPath) {
    await yt.thumbnails.set({
      videoId: opts.videoId,
      media: { body: createReadStream(opts.thumbnailPath) },
    });
  }
}

export type VideoAnalytics = {
  views: number;
  estimatedMinutesWatched: number | null;
  averageViewPercentage: number | null;
  impressions: number | null; // null when the channel/report doesn't expose it
  impressionCtr: number | null; // 0..1, null when unavailable
};

/**
 * Read a video's performance for a date window via the YouTube Analytics API.
 * `views` + watch-time are always available; impressions + CTR are best-effort
 * (only some channels/report types expose them) and come back null otherwise.
 * Dates are inclusive `YYYY-MM-DD` in the channel's timezone.
 */
export async function fetchVideoAnalytics(opts: {
  brandId: string;
  redirectUri: string;
  videoId: string;
  startDate: string;
  endDate: string;
}): Promise<VideoAnalytics> {
  const client = await clientFor(opts.brandId, opts.redirectUri);
  if (!client) {
    throw new Error(`youtube: brand ${opts.brandId} has no YouTube connection`);
  }
  const yta = google.youtubeAnalytics({ version: 'v2', auth: client });

  const core = await yta.reports.query({
    ids: 'channel==MINE',
    startDate: opts.startDate,
    endDate: opts.endDate,
    metrics: 'views,estimatedMinutesWatched,averageViewPercentage',
    filters: `video==${opts.videoId}`,
  });
  const row = (core.data.rows?.[0] as number[] | undefined) ?? [];
  const views = Number(row[0] ?? 0) || 0;
  const estimatedMinutesWatched = row[1] != null ? Number(row[1]) : null;
  const averageViewPercentage = row[2] != null ? Number(row[2]) : null;

  let impressions: number | null = null;
  let impressionCtr: number | null = null;
  try {
    const imp = await yta.reports.query({
      ids: 'channel==MINE',
      startDate: opts.startDate,
      endDate: opts.endDate,
      metrics: 'impressions,impressionClickThroughRate',
      filters: `video==${opts.videoId}`,
    });
    const r = imp.data.rows?.[0] as number[] | undefined;
    if (r) {
      impressions = Number(r[0] ?? 0);
      // The API returns CTR as a percentage (e.g. 4.2); normalize to 0..1.
      impressionCtr = r[1] != null ? Number(r[1]) / 100 : null;
    }
  } catch (err) {
    console.warn(
      `[youtube] impressions metrics unavailable for ${opts.videoId}: ${(err as Error).message}`,
    );
  }

  return { views, estimatedMinutesWatched, averageViewPercentage, impressions, impressionCtr };
}

/**
 * Read-only helper for the brand UI: is this brand connected, and to which
 * channel? Doesn't return tokens — never serialized to the client. `analytics`
 * reports whether the saved grant covers the YouTube Analytics scope (needed
 * for A/B experiments); pre-v1.5 connections won't have it until reconnect.
 */
export async function youtubeConnectionStatus(brandId: string): Promise<{
  connected: boolean;
  channelId: string | null;
  channelTitle: string | null;
  connectedAt: string | null;
  analytics: boolean;
}> {
  const [row] = await db
    .select({ youtubeOauth: brands.youtubeOauth })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  const o = row?.youtubeOauth;
  if (!o?.refresh_token) {
    return {
      connected: false,
      channelId: null,
      channelTitle: null,
      connectedAt: null,
      analytics: false,
    };
  }
  return {
    connected: true,
    channelId: o.channel_id ?? null,
    channelTitle: o.channel_title ?? null,
    connectedAt: o.connected_at,
    analytics: (o.scope ?? '').includes(YT_ANALYTICS_SCOPE),
  };
}
