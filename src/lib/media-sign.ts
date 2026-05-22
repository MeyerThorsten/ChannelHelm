import { createHmac, timingSafeEqual } from 'node:crypto';
import { sep } from 'node:path';
import { MEDIA_ROOT, resolveMediaPath } from './media-path';

/**
 * §9.4 signed media URLs. Rendered clips served through the Cloudflare Tunnel
 * must use short-TTL signed URLs so private media isn't crawlable. We mint a
 * signature just-in-time at dispatch (so it can't expire on the shelf) and the
 * `/media/*` edge verifies it.
 *
 * Secret: MEDIA_URL_SECRET (falls back to LOCAL_BEARER_TOKEN). Public host:
 * CLOUDFLARE_TUNNEL_HOSTNAME. Without both, no signed URL can be produced and
 * rendered-clip dispatch must fail closed.
 */
const secret = () => process.env.MEDIA_URL_SECRET ?? process.env.LOCAL_BEARER_TOKEN ?? '';

/** Absolute on-disk media path → slash-joined path relative to MEDIA_ROOT, or null if it escapes. */
export function relMediaPath(absPath: string): string | null {
  const resolved = resolveMediaPath(absPath);
  if (!resolved || resolved === MEDIA_ROOT) return null;
  return resolved
    .slice(MEDIA_ROOT.length + 1)
    .split(sep)
    .join('/');
}

export function signMediaRel(rel: string, exp: number): string {
  return createHmac('sha256', secret()).update(`${rel}:${exp}`).digest('hex');
}

/**
 * Build a signed, time-limited public URL for a local media file. Returns null
 * when no tunnel host or no secret is configured, or the path escapes
 * MEDIA_ROOT — callers must treat null as "cannot dispatch".
 */
export function signedMediaUrl(absPath: string, ttlSeconds = 900): string | null {
  const host = process.env.CLOUDFLARE_TUNNEL_HOSTNAME;
  if (!host || !secret()) return null;
  const rel = relMediaPath(absPath);
  if (!rel) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signMediaRel(rel, exp);
  const encoded = rel.split('/').map(encodeURIComponent).join('/');
  return `${host.replace(/\/$/, '')}/media/${encoded}?exp=${exp}&sig=${sig}`;
}

/** Verify a `(rel, exp, sig)` triple: secret set, not expired, constant-time HMAC match. */
export function verifyMediaSignature(rel: string, exp: number, sig: string | null): boolean {
  if (!sig || !secret()) return false;
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
  let a: Buffer;
  let b: Buffer;
  try {
    a = Buffer.from(signMediaRel(rel, exp), 'hex');
    b = Buffer.from(sig, 'hex');
  } catch {
    return false;
  }
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
