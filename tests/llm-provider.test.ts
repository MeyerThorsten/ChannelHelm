import { selectProvider } from '@workers/integrations/llm/get_provider';
import { describe, expect, it } from 'vitest';

type Rec = { id: number; enabled: boolean; purpose: string; isDefault: boolean };
const rec = (id: number, p: Partial<Rec> = {}): Rec => ({
  id,
  enabled: true,
  purpose: 'all',
  isDefault: false,
  ...p,
});

describe('selectProvider', () => {
  it('returns null when nothing is enabled', () => {
    expect(selectProvider([rec(1, { enabled: false })], 'all')).toBeNull();
    expect(selectProvider([], 'all')).toBeNull();
  });

  it('prefers an exact purpose match over an all-purpose provider', () => {
    const out = selectProvider(
      [rec(1, { purpose: 'all', isDefault: true }), rec(2, { purpose: 'premium_multimodal' })],
      'premium_multimodal',
    );
    expect(out?.id).toBe(2);
  });

  it('falls back to all-purpose when no exact match', () => {
    const out = selectProvider(
      [rec(1, { purpose: 'all' }), rec(2, { purpose: 'fast_audio_only' })],
      'standard_audio_visual',
    );
    expect(out?.id).toBe(1);
  });

  it('breaks ties by default flag then id', () => {
    const out = selectProvider(
      [rec(1, { purpose: 'all' }), rec(2, { purpose: 'all', isDefault: true })],
      'all',
    );
    expect(out?.id).toBe(2);
  });

  it('NEVER selects an unrelated profile-specific provider (#17)', () => {
    // only a premium provider exists; asking for standard must fall through to null
    expect(
      selectProvider([rec(1, { purpose: 'premium_multimodal' })], 'standard_audio_visual'),
    ).toBeNull();
  });

  it('still falls back to a default-flagged provider of another purpose', () => {
    const out = selectProvider(
      [rec(1, { purpose: 'premium_multimodal', isDefault: true })],
      'standard_audio_visual',
    );
    expect(out?.id).toBe(1);
  });

  it('skips disabled even when they match the purpose', () => {
    const out = selectProvider(
      [rec(1, { purpose: 'premium_multimodal', enabled: false }), rec(2, { purpose: 'all' })],
      'premium_multimodal',
    );
    expect(out?.id).toBe(2);
  });
});
