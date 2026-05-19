import { describe, expect, it } from 'vitest';
import { buildWindows } from '@workers/kinds/fuse';

const seg = (start: number, end: number, text: string) => ({ start, end, text });
const frame = (timestamp: number, description = '', text = '') => ({
  timestamp,
  description,
  on_screen_text: text ? [{ text, confidence: 0.9, bbox: [0, 0, 1, 1] }] : [],
  on_screen_text_joined: text,
});

describe('buildWindows', () => {
  it('produces ceil(total / window) buckets, last truncated', () => {
    const w = buildWindows({
      totalSeconds: 19,
      windowSeconds: 8,
      segments: [],
      frames: [],
      sceneCuts: [],
    });
    // [0-8), [8-16), [16-19) → 3 windows
    expect(w).toHaveLength(3);
    expect(w[0]?.start).toBe(0);
    expect(w[0]?.end).toBe(8);
    expect(w[2]?.end).toBe(19);
  });

  it('routes transcript segments to the windows they overlap', () => {
    const w = buildWindows({
      totalSeconds: 16,
      windowSeconds: 8,
      segments: [seg(0, 3, 'hello'), seg(5, 9, 'world straddles')],
      frames: [],
      sceneCuts: [],
    });
    expect(w[0]?.text).toContain('hello');
    expect(w[0]?.text).toContain('world straddles'); // straddles → both windows
    expect(w[1]?.text).toContain('world straddles');
  });

  it('computes speech_rate_wpm from word count / window seconds', () => {
    const text = Array.from({ length: 16 }, () => 'word').join(' ');
    const w = buildWindows({
      totalSeconds: 8,
      windowSeconds: 8,
      segments: [seg(0, 8, text)],
      frames: [],
      sceneCuts: [],
    });
    // 16 words / 8s = 2 wps → 120 wpm
    expect(w[0]?.audio_features.speech_rate_wpm).toBe(120);
  });

  it('emits speech_rate_delta vs previous window with sign', () => {
    const w = buildWindows({
      totalSeconds: 16,
      windowSeconds: 8,
      segments: [
        seg(0, 8, Array.from({ length: 8 }, () => 'a').join(' ')), //  60 wpm
        seg(8, 16, Array.from({ length: 16 }, () => 'a').join(' ')), // 120 wpm
      ],
      frames: [],
      sceneCuts: [],
    });
    expect(w[0]?.audio_features.speech_rate_delta).toBe('0%');
    expect(w[1]?.audio_features.speech_rate_delta).toBe('+100%');
  });

  it('routes frames to windows by timestamp', () => {
    const w = buildWindows({
      totalSeconds: 16,
      windowSeconds: 8,
      segments: [],
      frames: [frame(0, 'A'), frame(7, 'B'), frame(8, 'C'), frame(15, 'D')],
      sceneCuts: [],
    });
    expect(w[0]?.visual_descriptions.map((v) => v.description)).toEqual(['A', 'B']);
    expect(w[1]?.visual_descriptions.map((v) => v.description)).toEqual(['C', 'D']);
  });

  it('flags scene_boundary_within_window when a cut lands in range', () => {
    const w = buildWindows({
      totalSeconds: 16,
      windowSeconds: 8,
      segments: [],
      frames: [],
      sceneCuts: [11.2],
    });
    expect(w[0]?.scene_boundary_within_window).toBe(false);
    expect(w[1]?.scene_boundary_within_window).toBe(true);
  });

  it('collects OCR blocks from frames inside the window', () => {
    const w = buildWindows({
      totalSeconds: 8,
      windowSeconds: 8,
      segments: [],
      frames: [frame(1, '', 'first line'), frame(5, '', 'second line')],
      sceneCuts: [],
    });
    expect(w[0]?.on_screen_text).toHaveLength(2);
    expect(w[0]?.on_screen_text[0]?.text).toBe('first line');
  });

  it('records pause_after_seconds from gap between segments across boundary', () => {
    const w = buildWindows({
      totalSeconds: 16,
      windowSeconds: 8,
      segments: [seg(0, 6, 'first half'), seg(10, 14, 'second half')],
      frames: [],
      sceneCuts: [],
    });
    expect(w[0]?.audio_features.pause_after_seconds).toBe(4);
  });
});
