import { ProcessingProfile, isAudioOnlyProfile } from '@/lib/schemas';
import { describe, expect, it } from 'vitest';

describe('ProcessingProfile enum', () => {
  it('accepts the four valid profiles', () => {
    for (const p of [
      'transcription_only',
      'fast_audio_only',
      'standard_audio_visual',
      'premium_multimodal',
    ]) {
      expect(ProcessingProfile.safeParse(p).success).toBe(true);
    }
  });
  it('rejects unknown profiles', () => {
    expect(ProcessingProfile.safeParse('ultra').success).toBe(false);
    expect(ProcessingProfile.safeParse('').success).toBe(false);
  });
});

describe('isAudioOnlyProfile', () => {
  it('is true for audio-only profiles (skip visual + diarization + thumbnails)', () => {
    expect(isAudioOnlyProfile('transcription_only')).toBe(true);
    expect(isAudioOnlyProfile('fast_audio_only')).toBe(true);
  });
  it('is false for visual profiles', () => {
    expect(isAudioOnlyProfile('standard_audio_visual')).toBe(false);
    expect(isAudioOnlyProfile('premium_multimodal')).toBe(false);
  });
  it('is false for unknown strings', () => {
    expect(isAudioOnlyProfile('')).toBe(false);
    expect(isAudioOnlyProfile('whatever')).toBe(false);
  });
});
