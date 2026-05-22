import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// media-sign reads MEDIA_URL_SECRET / CLOUDFLARE_TUNNEL_HOSTNAME / MEDIA_ROOT
// at call time, so set them before importing the helpers.
const prev = {
  secret: process.env.MEDIA_URL_SECRET,
  host: process.env.CLOUDFLARE_TUNNEL_HOSTNAME,
  root: process.env.MEDIA_ROOT,
};
beforeAll(() => {
  process.env.MEDIA_URL_SECRET = 'test-media-secret';
  process.env.CLOUDFLARE_TUNNEL_HOSTNAME = 'https://media.example.com';
  process.env.MEDIA_ROOT = '/var/channelhelm/media';
});
afterAll(() => {
  process.env.MEDIA_URL_SECRET = prev.secret;
  process.env.CLOUDFLARE_TUNNEL_HOSTNAME = prev.host;
  process.env.MEDIA_ROOT = prev.root;
});

describe('media-sign (§9.4 signed media URLs)', () => {
  it('signs + verifies a round-trip', async () => {
    const { signMediaRel, verifyMediaSignature } = await import('@/lib/media-sign');
    const exp = Math.floor(Date.now() / 1000) + 900;
    const sig = signMediaRel('brand/src_1/clips/clip_000.mp4', exp);
    expect(verifyMediaSignature('brand/src_1/clips/clip_000.mp4', exp, sig)).toBe(true);
  });

  it('rejects an expired signature', async () => {
    const { signMediaRel, verifyMediaSignature } = await import('@/lib/media-sign');
    const past = Math.floor(Date.now() / 1000) - 1;
    const sig = signMediaRel('a/b.mp4', past);
    expect(verifyMediaSignature('a/b.mp4', past, sig)).toBe(false);
  });

  it('rejects a tampered path', async () => {
    const { signMediaRel, verifyMediaSignature } = await import('@/lib/media-sign');
    const exp = Math.floor(Date.now() / 1000) + 900;
    const sig = signMediaRel('a/b.mp4', exp);
    expect(verifyMediaSignature('a/other.mp4', exp, sig)).toBe(false);
  });

  it('rejects a missing/garbage signature', async () => {
    const { verifyMediaSignature } = await import('@/lib/media-sign');
    const exp = Math.floor(Date.now() / 1000) + 900;
    expect(verifyMediaSignature('a/b.mp4', exp, null)).toBe(false);
    expect(verifyMediaSignature('a/b.mp4', exp, 'zzzz')).toBe(false);
  });

  it('builds a signed public URL under the tunnel host', async () => {
    const { signedMediaUrl } = await import('@/lib/media-sign');
    const url = signedMediaUrl('/var/channelhelm/media/brand/src_1/clips/clip_000.mp4', 900);
    expect(url).toMatch(
      /^https:\/\/media\.example\.com\/media\/brand\/src_1\/clips\/clip_000\.mp4\?exp=\d+&sig=[0-9a-f]+$/,
    );
  });

  it('returns null for a path that escapes MEDIA_ROOT', async () => {
    const { signedMediaUrl } = await import('@/lib/media-sign');
    expect(signedMediaUrl('/etc/passwd', 900)).toBeNull();
  });
});
