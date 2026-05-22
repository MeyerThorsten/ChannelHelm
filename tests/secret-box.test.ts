import { afterEach, describe, expect, it } from 'vitest';

const prev = process.env.PROVIDER_SECRET_KEY;
afterEach(() => {
  process.env.PROVIDER_SECRET_KEY = prev;
});

describe('secret-box (#14 encrypt provider keys at rest)', () => {
  it('round-trips when a key is configured, and the ciphertext is not the plaintext', async () => {
    process.env.PROVIDER_SECRET_KEY = 'unit-test-key';
    const { encryptSecret, decryptSecret, isEncrypted } = await import('@/lib/secret-box');
    const enc = encryptSecret('sk-supersecret-123');
    expect(enc).not.toContain('supersecret');
    expect(isEncrypted(enc)).toBe(true);
    expect(decryptSecret(enc)).toBe('sk-supersecret-123');
  });

  it('reads legacy plaintext transparently', async () => {
    process.env.PROVIDER_SECRET_KEY = 'unit-test-key';
    const { decryptSecret } = await import('@/lib/secret-box');
    expect(decryptSecret('sk-plain')).toBe('sk-plain');
  });

  it('stores plaintext when no key is configured (graceful local dev)', async () => {
    process.env.PROVIDER_SECRET_KEY = '';
    const { encryptSecret, isEncrypted } = await import('@/lib/secret-box');
    const out = encryptSecret('sk-x');
    expect(out).toBe('sk-x');
    expect(isEncrypted(out)).toBe(false);
  });

  it('empty input stays empty', async () => {
    process.env.PROVIDER_SECRET_KEY = 'unit-test-key';
    const { encryptSecret } = await import('@/lib/secret-box');
    expect(encryptSecret('')).toBe('');
  });
});
