/**
 * Thin Zernio client. Until the official `zernio` npm SDK ships in a version
 * we want to pin, this wrapper speaks the documented HTTP contract from §9.
 *
 * Configure via env:
 *   ZERNIO_API_KEY     — required for actual dispatch
 *   ZERNIO_API_URL     — defaults to https://api.zernio.com/v1
 */

const BASE = process.env.ZERNIO_API_URL ?? 'https://api.zernio.com/v1';
const KEY = process.env.ZERNIO_API_KEY ?? '';

export type ZernioPostRequest = {
  profileId: string;
  network: 'linkedin' | 'x' | 'instagram';
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
