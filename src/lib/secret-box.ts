import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

/**
 * #14: encrypt provider API keys at rest with a local secret
 * (PROVIDER_SECRET_KEY) that lives outside Postgres, so a DB/backup leak
 * doesn't expose third-party keys. AES-256-GCM; values are tagged with a
 * version prefix. When PROVIDER_SECRET_KEY is unset (e.g. fresh local dev),
 * values are stored as-is and read back transparently — set the key to turn
 * on encryption. Legacy plaintext rows decrypt to themselves.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer | null {
  const s = process.env.PROVIDER_SECRET_KEY;
  return s ? scryptSync(s, 'channelhelm-provider-secret', 32) : null;
}

export function encryptSecret(plain: string): string {
  const k = key();
  if (!k || !plain) return plain;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', k, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptSecret(stored: string): string {
  if (!stored || !stored.startsWith(PREFIX)) return stored; // legacy plaintext
  const k = key();
  if (!k) return ''; // encrypted but no key available — fail closed
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const enc = raw.subarray(28);
    const d = createDecipheriv('aes-256-gcm', k, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function isEncrypted(stored: string): boolean {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}
