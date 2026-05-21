import { ZERNIO_NETWORKS, networkFor } from '@workers/integrations/zernio';
import { describe, expect, it } from 'vitest';

describe('ZERNIO_NETWORKS', () => {
  it('lists all 15 LATE/Zernio platforms', () => {
    expect(ZERNIO_NETWORKS).toHaveLength(15);
    for (const n of [
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
    ]) {
      expect(ZERNIO_NETWORKS).toContain(n);
    }
  });
});

describe('networkFor', () => {
  it('maps known asset types to their default network', () => {
    expect(networkFor('linkedin_post')).toBe('linkedin');
    expect(networkFor('x_post')).toBe('x');
    expect(networkFor('x_thread')).toBe('x');
    expect(networkFor('rendered_short_clip')).toBe('instagram');
    expect(networkFor('rendered_long_clip')).toBe('youtube');
    expect(networkFor('threads_post')).toBe('threads');
    expect(networkFor('discord_message')).toBe('discord');
  });
  it('falls back to x for unknown types', () => {
    expect(networkFor('something_new')).toBe('x');
  });
  it('every mapped network is a valid ZERNIO_NETWORK', () => {
    for (const t of ['linkedin_post', 'rendered_long_clip', 'pinterest_pin', 'bluesky_post']) {
      expect(ZERNIO_NETWORKS).toContain(networkFor(t));
    }
  });
});
