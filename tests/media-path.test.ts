import { isPathInsideMediaRoot, mediaUrlFor, resolveMediaPath } from '@/lib/media-path';
import { describe, expect, it } from 'vitest';

const ROOT = '/var/channelhelm/media';

describe('resolveMediaPath', () => {
  it('resolves a normal relative path', () => {
    expect(resolveMediaPath('brand/src_1/original.mp4', ROOT)).toBe(
      '/var/channelhelm/media/brand/src_1/original.mp4',
    );
  });
  it('blocks ../ traversal', () => {
    expect(resolveMediaPath('../../etc/passwd', ROOT)).toBeNull();
    expect(resolveMediaPath('brand/../../../etc/passwd', ROOT)).toBeNull();
  });
  it('blocks absolute escape', () => {
    expect(resolveMediaPath('/etc/passwd', ROOT)).toBeNull();
  });
  it('accepts an absolute path that is already inside root', () => {
    expect(resolveMediaPath('/var/channelhelm/media/a/b.mp4', ROOT)).toBe(
      '/var/channelhelm/media/a/b.mp4',
    );
  });
});

describe('isPathInsideMediaRoot', () => {
  it('true for inside, false for escape', () => {
    expect(isPathInsideMediaRoot('a/b.mp4', ROOT)).toBe(true);
    expect(isPathInsideMediaRoot('../x', ROOT)).toBe(false);
  });
});

describe('mediaUrlFor', () => {
  it('builds a /api/media URL with encoded segments', () => {
    expect(mediaUrlFor('/var/channelhelm/media/my brand/src_1/original.mp4', ROOT)).toBe(
      '/api/media/my%20brand/src_1/original.mp4',
    );
  });
  it('returns null for paths outside root', () => {
    expect(mediaUrlFor('/etc/passwd', ROOT)).toBeNull();
  });
  it('returns null for the root itself', () => {
    expect(mediaUrlFor(ROOT, ROOT)).toBeNull();
  });
});
