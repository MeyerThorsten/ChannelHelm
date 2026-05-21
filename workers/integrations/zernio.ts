/**
 * Thin Zernio (LATE) client. getlate.dev rebranded to zernio.com; this is
 * the same social posting API the contract calls "Zernio". Until we pin the
 * official `@getlatedev/social-media-api` SDK, this wrapper speaks the
 * documented HTTP contract.
 *
 * Configure via env:
 *   ZERNIO_API_KEY     — required for actual dispatch
 *   ZERNIO_API_URL     — defaults to https://api.zernio.com/v1
 */

const BASE = process.env.ZERNIO_API_URL ?? 'https://api.zernio.com/v1';
const KEY = process.env.ZERNIO_API_KEY ?? '';

/** All 15 networks LATE/Zernio supports (docs.zernio.com/platforms). */
export const ZERNIO_NETWORKS = [
  'x',
  'instagram',
  'facebook',
  'linkedin',
  'tiktok',
  'youtube',
  'pinterest',
  'reddit',
  'bluesky',
  'threads',
  'google_business',
  'telegram',
  'snapchat',
  'whatsapp',
  'discord',
] as const;

export type ZernioNetwork = (typeof ZERNIO_NETWORKS)[number];

// Asset type → default LATE/Zernio network. Vertical clips default to
// Instagram (Reels); the same rendered_* asset can be cross-posted to
// tiktok / youtube shorts / threads via additional dispatches.
const NETWORK_BY_TYPE: Record<string, ZernioNetwork> = {
  linkedin_post: 'linkedin',
  x_post: 'x',
  x_thread: 'x',
  rendered_short_clip: 'instagram',
  rendered_long_clip: 'youtube',
  instagram_caption: 'instagram',
  facebook_post: 'facebook',
  tiktok_caption: 'tiktok',
  threads_post: 'threads',
  pinterest_pin: 'pinterest',
  reddit_post: 'reddit',
  bluesky_post: 'bluesky',
  telegram_post: 'telegram',
  discord_message: 'discord',
};

export function networkFor(type: string): ZernioNetwork {
  return NETWORK_BY_TYPE[type] ?? 'x';
}

export type ZernioPostRequest = {
  profileId: string;
  network: ZernioNetwork;
  content: { text?: string; mediaUrls?: string[]; threadPosts?: string[] };
  scheduledFor?: string; // ISO timestamp; omit for immediate
  callbackUrl?: string;
};

export type ZernioPostResponse = {
  _id: string;
  status: 'scheduled' | 'published' | 'failed';
  network: string;
};

export async function createPost(req: ZernioPostRequest): Promise<ZernioPostResponse> {
  if (!KEY) {
    throw new Error('zernio: ZERNIO_API_KEY not set — refusing to dispatch (configure in .env)');
  }
  const res = await fetch(`${BASE}/posts`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const tail = await res.text().catch(() => '');
    throw new Error(`zernio: ${res.status} ${res.statusText} ${tail.slice(0, 500)}`);
  }
  return (await res.json()) as ZernioPostResponse;
}

/**
 * Pull analytics for a previously-dispatched post. Used by collect_signal.
 */
export async function fetchAnalytics(externalId: string): Promise<{
  impressions: number;
  engagement: number;
  ctr: number | null;
  last_sampled_at: string;
}> {
  if (!KEY) {
    throw new Error('zernio: ZERNIO_API_KEY not set');
  }
  const res = await fetch(`${BASE}/posts/${externalId}/analytics`, {
    headers: { authorization: `Bearer ${KEY}` },
  });
  if (!res.ok) {
    throw new Error(`zernio: analytics ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as {
    impressions: number;
    engagement: number;
    ctr: number | null;
    last_sampled_at: string;
  };
}
