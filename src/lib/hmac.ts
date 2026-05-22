import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a webhook signature.
 *
 * Behavior:
 *   - When `secret` is unset (operator hasn't configured one yet), returns
 *     `{ ok: true, mode: 'unverified' }`. v1 ships in that state on
 *     purpose; receivers print a warning per request so it's visible.
 *   - When `secret` is set, computes `sha256(secret, rawBody)` in hex and
 *     compares to the value of the configured header in constant time.
 *     Returns `{ ok: false }` on mismatch or missing header.
 *
 * Zernio doesn't publish a standard header name; we make it configurable
 * via env (defaults to `x-zernio-signature`). DojoClaw is LAN-only but the
 * same verification path applies via `x-dojoclaw-signature`.
 */
export type HmacCheck =
  | { ok: true; mode: 'verified' | 'unverified' }
  | { ok: false; reason: 'missing_header' | 'bad_signature' };

export function verifyHmac(opts: {
  secret: string | undefined;
  headerName: string;
  headerValue: string | null;
  rawBody: string;
}): HmacCheck {
  if (!opts.secret) {
    return { ok: true, mode: 'unverified' };
  }
  if (!opts.headerValue) {
    return { ok: false, reason: 'missing_header' };
  }
  const expected = createHmac('sha256', opts.secret).update(opts.rawBody).digest('hex');
  // Strip optional `sha256=` prefix some platforms send (mirrors GitHub /
  // Stripe / Shopify conventions). Zernio's exact header format will be
  // pinned once they publish docs.
  const presented = opts.headerValue.startsWith('sha256=')
    ? opts.headerValue.slice('sha256='.length)
    : opts.headerValue;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(presented, 'hex');
  if (a.length !== b.length) return { ok: false, reason: 'bad_signature' };
  return timingSafeEqual(a, b)
    ? { ok: true, mode: 'verified' }
    : { ok: false, reason: 'bad_signature' };
}

/**
 * §8 fail-closed policy for webhook routes. Given a verification result and
 * whether unsigned webhooks are explicitly allowed (ALLOW_UNSIGNED_WEBHOOKS=1,
 * for local smoke tests only), decide whether to accept the request:
 *   - bad / missing signature           → 401
 *   - no secret configured + not allowed → 503 (refuse — do not fail open)
 *   - verified, or unsigned + allowed    → accept
 */
export type WebhookGate =
  | { accept: true; mode: 'verified' | 'unverified' }
  | { accept: false; status: number; body: { error: string; reason?: string } };

export function webhookGate(check: HmacCheck, allowUnsigned: boolean): WebhookGate {
  if (!check.ok) {
    return {
      accept: false,
      status: 401,
      body: { error: 'invalid_signature', reason: check.reason },
    };
  }
  if (check.mode === 'unverified' && !allowUnsigned) {
    return { accept: false, status: 503, body: { error: 'webhook_secret_required' } };
  }
  return { accept: true, mode: check.mode };
}
