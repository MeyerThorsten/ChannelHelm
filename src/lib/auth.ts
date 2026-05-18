import { timingSafeEqual } from 'node:crypto';

/**
 * Local-only bearer-token auth. Single operator. The token lives in
 * `LOCAL_BEARER_TOKEN` and never leaves the LAN.
 *
 * `requireAuth` returns `{ ok: true }` or an HTTP 401/503 Response, ready to
 * return from a route handler.
 */
export type AuthCheck = { ok: true } | { ok: false; response: Response };

export function requireAuth(req: Request): AuthCheck {
  const expected = process.env.LOCAL_BEARER_TOKEN;
  if (!expected) {
    return {
      ok: false,
      response: Response.json(
        { error: 'server_misconfigured', detail: 'LOCAL_BEARER_TOKEN is not set' },
        { status: 503 },
      ),
    };
  }
  const header = req.headers.get('authorization') ?? '';
  const presented = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';

  // Pad both sides to equal length for timingSafeEqual; mismatched length still
  // fails (we set `lengthMismatch` before the compare).
  const expectedBuf = Buffer.from(expected);
  const presentedBuf = Buffer.from(presented);
  const sameLength = expectedBuf.length === presentedBuf.length;
  const padded = sameLength ? presentedBuf : Buffer.alloc(expectedBuf.length);
  const equal = sameLength && timingSafeEqual(expectedBuf, padded);

  if (!equal) {
    return {
      ok: false,
      response: Response.json({ error: 'unauthorized' }, { status: 401 }),
    };
  }
  return { ok: true };
}
