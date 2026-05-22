import {
  ZERNIO_NETWORKS,
  candidateNetworks,
  networkFor,
  resolveZernioPlatforms,
} from '@workers/integrations/zernio';
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

describe('candidateNetworks (§9.3)', () => {
  it('short clips fan out to vertical-video networks', () => {
    expect(candidateNetworks('rendered_short_clip')).toEqual(['tiktok', 'instagram', 'youtube']);
  });
  it('long clips target youtube', () => {
    expect(candidateNetworks('rendered_long_clip')).toEqual(['youtube']);
  });
  it('text assets map to a single network', () => {
    expect(candidateNetworks('linkedin_post')).toEqual(['linkedin']);
  });
});

describe('resolveZernioPlatforms (§9.3 platforms[].accountId)', () => {
  it('intersects candidate networks with the brand accounts', () => {
    const out = resolveZernioPlatforms('rendered_short_clip', {
      tiktok: 'acc_tt',
      youtube: 'acc_yt',
      // no instagram account configured
    });
    expect(out).toEqual([
      { platform: 'tiktok', accountId: 'acc_tt' },
      { platform: 'youtube', accountId: 'acc_yt' },
    ]);
  });
  it('returns [] when no account is configured (dispatch must then fail)', () => {
    expect(resolveZernioPlatforms('linkedin_post', {})).toEqual([]);
  });
  it('maps a text asset to its single account', () => {
    expect(resolveZernioPlatforms('x_post', { x: 'acc_x' })).toEqual([
      { platform: 'x', accountId: 'acc_x' },
    ]);
  });
});
