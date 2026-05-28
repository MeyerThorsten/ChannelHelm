import {
  type ClipSegment,
  extractClipSegments,
  formatSrtTime,
  isSupportedLanguage,
  numberedSourceLines,
  reconcileTranslations,
  serializeSrt,
  serializeTranslatedAss,
} from '@/lib/subtitle-translate';
import { describe, expect, it } from 'vitest';

// A source transcript with segment-level start/end (source seconds).
const transcript = {
  segments: [
    { start: 0.0, end: 2.0, text: 'Look, if you are building' },
    { start: 2.0, end: 4.5, text: 'a high-power machine' },
    { start: 4.5, end: 7.0, text: 'you need the right cooling' },
    { start: 7.0, end: 9.0, text: 'or it melts' },
  ],
};

describe('formatSrtTime', () => {
  it('formats HH:MM:SS,mmm', () => {
    expect(formatSrtTime(0)).toBe('00:00:00,000');
    expect(formatSrtTime(1.5)).toBe('00:00:01,500');
    expect(formatSrtTime(61.25)).toBe('00:01:01,250');
    expect(formatSrtTime(3661.001)).toBe('01:01:01,001');
  });

  it('clamps negatives to zero', () => {
    expect(formatSrtTime(-5)).toBe('00:00:00,000');
  });

  it('rounds milliseconds correctly', () => {
    // 2.0009 → 2001 ms (rounds up)
    expect(formatSrtTime(2.0006)).toBe('00:00:02,001');
  });
});

describe('extractClipSegments — windowing', () => {
  it('rebases segments inside the clip to clip-local time', () => {
    const segs = extractClipSegments(transcript, 2.0, 7.0);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 0.0, end: 2.5, text: 'a high-power machine' });
    expect(segs[1]).toEqual({ start: 2.5, end: 5.0, text: 'you need the right cooling' });
  });

  it('clamps a segment that straddles the clip start', () => {
    // clip [1.0, 3.0]: segment 0 (0..2) clamps to local [0, 1.0];
    // segment 1 (2..4.5) clamps to local [1.0, 2.0].
    const segs = extractClipSegments(transcript, 1.0, 3.0);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toEqual({ start: 0.0, end: 1.0, text: 'Look, if you are building' });
    expect(segs[1]).toEqual({ start: 1.0, end: 2.0, text: 'a high-power machine' });
  });

  it('excludes segments fully outside the window', () => {
    const segs = extractClipSegments(transcript, 4.5, 7.0);
    expect(segs.map((s) => s.text)).toEqual(['you need the right cooling']);
  });

  it('returns [] for empty / malformed / inverted input', () => {
    expect(extractClipSegments(null, 0, 5)).toEqual([]);
    expect(extractClipSegments({}, 0, 5)).toEqual([]);
    expect(extractClipSegments(transcript, 5, 5)).toEqual([]);
    expect(extractClipSegments(transcript, 5, 2)).toEqual([]);
    expect(extractClipSegments({ segments: [{ text: 'no timing' }] }, 0, 5)).toEqual([]);
  });
});

describe('reconcileTranslations — count-mismatch guard', () => {
  const src: ClipSegment[] = [
    { start: 0, end: 2, text: 'one' },
    { start: 2, end: 4, text: 'two' },
    { start: 4, end: 6, text: 'three' },
  ];

  it('pairs translations positionally when counts match', () => {
    const { texts, usedFallback } = reconcileTranslations(src, ['uno', 'dos', 'tres']);
    expect(texts).toEqual(['uno', 'dos', 'tres']);
    expect(usedFallback).toBe(false);
  });

  it('falls back to source text for the whole clip when counts differ', () => {
    const short = reconcileTranslations(src, ['uno', 'dos']); // too few
    expect(short.texts).toEqual(['one', 'two', 'three']);
    expect(short.usedFallback).toBe(true);

    const long = reconcileTranslations(src, ['uno', 'dos', 'tres', 'cuatro']); // too many
    expect(long.texts).toEqual(['one', 'two', 'three']);
    expect(long.usedFallback).toBe(true);
  });

  it('keeps source text for an individual blank translated line', () => {
    const { texts, usedFallback } = reconcileTranslations(src, ['uno', '', 'tres']);
    expect(texts).toEqual(['uno', 'two', 'tres']);
    expect(usedFallback).toBe(false);
  });

  it('ignores non-string translated entries', () => {
    // biome-ignore lint/suspicious/noExplicitAny: deliberately exercising bad LLM output
    const { texts } = reconcileTranslations(src, ['uno', 42 as any, null as any]);
    expect(texts).toEqual(['uno', 'two', 'three']);
  });
});

describe('serializeSrt', () => {
  it('emits sequential cues with HH:MM:SS,mmm windows', () => {
    const segs = extractClipSegments(transcript, 2.0, 7.0);
    const srt = serializeSrt(segs, ['una máquina de alta potencia', 'necesitas la refrigeración']);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:02,500\nuna máquina de alta potencia');
    expect(srt).toContain('2\n00:00:02,500 --> 00:00:05,000\nnecesitas la refrigeración');
  });

  it('skips blank cues and keeps numbering contiguous', () => {
    const segs: ClipSegment[] = [
      { start: 0, end: 1, text: 'a' },
      { start: 1, end: 2, text: 'b' },
      { start: 2, end: 3, text: 'c' },
    ];
    const srt = serializeSrt(segs, ['uno', '  ', 'tres']);
    expect(srt).toContain('1\n00:00:00,000 --> 00:00:01,000\nuno');
    // The middle cue is skipped; the third becomes cue 2.
    expect(srt).toContain('2\n00:00:02,000 --> 00:00:03,000\ntres');
    expect(srt).not.toContain('3\n');
  });
});

describe('serializeTranslatedAss', () => {
  const segs = extractClipSegments(transcript, 2.0, 7.0);

  it('emits required ASS sections + one dialogue line per non-blank segment', () => {
    const ass = serializeTranslatedAss({
      clipWidth: 1080,
      clipHeight: 1920,
      segments: segs,
      texts: ['una máquina', 'la refrigeración'],
    });
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('[Events]');
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(2);
  });

  it('uses clip-local ASS timestamps', () => {
    const ass = serializeTranslatedAss({
      clipWidth: 1080,
      clipHeight: 1920,
      segments: segs,
      texts: ['una máquina', 'la refrigeración'],
    });
    // segment 0 local [0, 2.5] → 0:00:00.00 --> 0:00:02.50
    expect(ass).toMatch(/0:00:00\.00,0:00:02\.50/);
  });

  it('honours an operator style block (font + position)', () => {
    const ass = serializeTranslatedAss({
      clipWidth: 1080,
      clipHeight: 1920,
      segments: segs,
      texts: ['una máquina', 'la refrigeración'],
      style: { font: 'Poppins', x_pos: 0.5, y_pos: 0.5, animation: 'banner' },
    });
    expect(ass).toContain('Style: Default,Poppins,');
    expect(ass).toContain('\\pos(540,960)'); // 1080*0.5, 1920*0.5
    expect(ass).toContain(',4,2,1,'); // BorderStyle 4 for banner
  });

  it('escapes braces to prevent ASS injection', () => {
    const ass = serializeTranslatedAss({
      clipWidth: 1080,
      clipHeight: 1920,
      segments: [{ start: 0, end: 1, text: '{evil}' }],
      texts: ['{evil}'],
    });
    expect(ass).toContain('\\{evil\\}');
  });
});

describe('numberedSourceLines', () => {
  it('numbers lines 1-based and collapses whitespace', () => {
    const block = numberedSourceLines([
      { start: 0, end: 1, text: 'hello   world' },
      { start: 1, end: 2, text: 'second' },
    ]);
    expect(block).toBe('1. hello world\n2. second');
  });
});

describe('isSupportedLanguage', () => {
  it('accepts curated ISO-639-1 codes', () => {
    expect(isSupportedLanguage('es')).toBe(true);
    expect(isSupportedLanguage('de')).toBe(true);
    expect(isSupportedLanguage('ja')).toBe(true);
  });

  it('rejects unknown / malformed codes', () => {
    expect(isSupportedLanguage('xx')).toBe(false);
    expect(isSupportedLanguage('english')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
  });
});
