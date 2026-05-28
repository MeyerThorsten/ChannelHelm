/**
 * YouTube Data API v3 integration. Operator goes through Google OAuth once
 * per brand at `/api/youtube/oauth/start` — we receive a refresh_token,
 * encrypt it via secret-box, store it on `brands.youtube_oauth`. The
 * dispatch worker exchanges the refresh_token for a short-lived access_token
 * before each upload, then streams `original.mp4` to YouTube's resumable
 * upload endpoint.
 *
 * Scopes required:
 *   youtube.upload  — for videos.insert
 *   youtube         — for thumbnails.set (and listing the channel)
 *
 * Quota: each upload is 1,600 units; default 10,000/day = ~6 uploads. Bump
 * via the GCP console if you scale.
 */

import { createReadStream, statSync } from 'node:fs';
import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { decryptSecret, encryptSecret } from '@/lib/secret-box';
import { google, type youtube_v3 } from 'googleapis';
import { type OAuth2Client } from 'google-auth-library';
import { eq, sql } from 'drizzle-orm';

const YT_SCOPES = [
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube',
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
 * brand id encoded in `state` so the callback can map back.
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
export function youtubeAuthUrl(
  brandId: string,
  redirectUri: string,
  loginHint?: string,
): string {
  const client = oauthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'select_account consent',
    scope: YT_SCOPES,
    state: brandId,
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
    const item = me.data.items?.[0];
    channelId = item?.id ?? null;
    channelTitle = item?.snippet?.title ?? null;
  } catch (err) {
    console.warn('[youtube] channel lookup failed (continuing):', (err as Error).message);
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
 * Read-only helper for the brand UI: is this brand connected, and to which
 * channel? Doesn't return tokens — never serialized to the client.
 */
export async function youtubeConnectionStatus(
  brandId: string,
): Promise<{ connected: boolean; channelId: string | null; channelTitle: string | null; connectedAt: string | null }> {
  const [row] = await db
    .select({ youtubeOauth: brands.youtubeOauth })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  const o = row?.youtubeOauth;
  if (!o?.refresh_token) {
    return { connected: false, channelId: null, channelTitle: null, connectedAt: null };
  }
  return {
    connected: true,
    channelId: o.channel_id ?? null,
    channelTitle: o.channel_title ?? null,
    connectedAt: o.connected_at,
  };
}
