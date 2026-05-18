/**
 * Thin DojoClaw HTTP client. DojoClaw runs on the LAN at
 * `$DOJOCLAW_API_URL` (default http://m4max.local:8788) and exposes an
 * authenticated REST API for queueing article-writing jobs.
 *
 * Contract per §8. v1 only wires the brief-submission endpoint; collecting
 * the article output happens via the `/api/webhooks/dojoclaw` receiver.
 */

const BASE = process.env.DOJOCLAW_API_URL ?? 'http://m4max.local:8788';
const KEY = process.env.DOJOCLAW_API_KEY ?? '';

export type DojoclawBriefRequest = {
  brand_slug: string;
  package_id: string;
  asset_id: string;
  brief: Record<string, unknown>;
  callback_url: string;
};

export type DojoclawBriefResponse = {
  job_id: string;
  status: 'queued' | 'running' | 'done';
};

export async function submitBrief(req: DojoclawBriefRequest): Promise<DojoclawBriefResponse> {
  if (!KEY) {
    throw new Error(
      'dojoclaw: DOJOCLAW_API_KEY not set — refusing to dispatch (configure in .env)',
    );
  }
  const res = await fetch(`${BASE}/api/briefs`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const tail = await res.text().catch(() => '');
    throw new Error(`dojoclaw: ${res.status} ${res.statusText} ${tail.slice(0, 500)}`);
  }
  return (await res.json()) as DojoclawBriefResponse;
}
