import { describe, expect, it } from 'vitest';
import { type AssAnimation, type AssStyle, hexToAss, serializeAss } from '@/lib/ass-subtitles';
import type { WordTiming } from '@/lib/word-snap';

const baseStyle = (overrides: Partial<AssStyle> = {}): AssStyle => ({
  font: 'Montserrat',
  font_size: 70,
  font_color: '#FFFFFF',
  highlight_color: '#39FF14',
  animation: 'word_highlight',
  x_pos: 0.5,
  y_pos: 0.65,
  ...overrides,
});

const sampleWords: WordTiming[] = [
  { word: 'Look', start: 0.0, end: 0.28 },
  { word: 'if', start: 0.28, end: 0.48 },
  { word: "you're", start: 0.48, end: 0.78 },
  { word: 'building', start: 0.78, end: 1.18 },
  { word: 'a', start: 1.18, end: 1.25 },
  { word: 'high-power', start: 1.25, end: 1.92 },
];

describe('hexToAss', () => {
  it('reverses RRGGBB → BBGGRR with alpha 00 prefix', () => {
    expect(hexToAss('#FF0000')).toBe('&H000000FF'); // red
    expect(hexToAss('#00FF00')).toBe('&H0000FF00'); // green
    expect(hexToAss('#0000FF')).toBe('&H00FF0000'); // blue
    expect(hexToAss('#FFFFFF')).toBe('&H00FFFFFF'); // white
    expect(hexToAss('#000000')).toBe('&H00000000'); // black
  });

  it('handles mixed case + missing prefix', () => {
    expect(hexToAss('ff00aa')).toBe('&H00AA00FF');
    expect(hexToAss('  #aBcDeF  ')).toBe('&H00EFCDAB');
  });

  it('falls back to white on parse failure', () => {
    expect(hexToAss('not-a-color')).toBe('&H00FFFFFF');
    expect(hexToAss('#xyz')).toBe('&H00FFFFFF');
    expect(hexToAss('')).toBe('&H00FFFFFF');
  });
});

describe('serializeAss', () => {
  it('emits required ASS sections', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle(),
    });
    expect(ass).toContain('[Script Info]');
    expect(ass).toContain('PlayResX: 1080');
    expect(ass).toContain('PlayResY: 1920');
    expect(ass).toContain('[V4+ Styles]');
    expect(ass).toContain('Style: Default,Montserrat,70');
    expect(ass).toContain('[Events]');
  });

  it('produces dialogue lines with absolute positioning', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ x_pos: 0.5, y_pos: 0.65 }),
    });
    // \pos(540,1248) = 1080*0.5, 1920*0.65
    expect(ass).toContain('\\pos(540,1248)');
  });

  it('groups words into rows of 4 for default animations', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'word_highlight' }),
    });
    // 6 words → 1 row of 4 + 1 row of 2 = 2 Dialogue lines
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(2);
  });

  it('emits one Dialogue line per word for single_word animation', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'single_word' }),
    });
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'));
    expect(lines).toHaveLength(6); // one per word
  });

  it('uses BorderStyle 4 (box) only for banner', () => {
    const banner = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'banner' }),
    });
    const highlight = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'word_highlight' }),
    });
    // BorderStyle is the 16th field in the Style line — easier to check by
    // looking for the unique 8-comma block before alignment.
    expect(banner).toContain(',4,2,1,');
    expect(highlight).toContain(',1,2,1,');
  });

  it('rebases word timings to clip-local time', () => {
    // Clip is [10s, 13s]; word at source 10.5s should appear at local 0.5s.
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 10.0,
      clipEndSeconds: 13.0,
      words: [
        { word: 'first', start: 10.2, end: 10.55 },
        { word: 'second', start: 10.55, end: 11.0 },
      ],
      style: baseStyle(),
    });
    // Local times: 0.20 → 0.55 → 1.00 → fmt as 0:00:00.20, 0:00:01.00
    expect(ass).toMatch(/0:00:00\.20/);
    expect(ass).toMatch(/0:00:01\.00/);
  });

  it('excludes words outside the clip range', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 1.0,
      clipEndSeconds: 2.0,
      words: sampleWords,
      style: baseStyle(),
    });
    // Only "building" (0.78-1.18), "a" (1.18-1.25), "high-power" (1.25-1.92) overlap
    expect(ass).toContain('building');
    expect(ass).toContain('high-power');
    expect(ass).not.toContain('Look');
  });

  it('handles all 6 animation styles without throwing', () => {
    const animations: AssAnimation[] = [
      'word_highlight',
      'banner',
      'pop',
      'single_word',
      'typewriter',
      'motion',
    ];
    for (const animation of animations) {
      const ass = serializeAss({
        clipWidth: 1080,
        clipHeight: 1920,
        clipStartSeconds: 0,
        clipEndSeconds: 2.5,
        words: sampleWords,
        style: baseStyle({ animation }),
      });
      expect(ass.length).toBeGreaterThan(100);
      expect(ass).toContain('Dialogue:');
    }
  });

  it('emits karaoke \\k tags for word_highlight', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'word_highlight' }),
    });
    expect(ass).toMatch(/\\k\d+/);
  });

  it('emits scale animation tags for pop', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'pop' }),
    });
    expect(ass).toContain('\\fscx120');
    expect(ass).toContain('\\fscx100');
  });

  it('emits alpha fade for typewriter', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'typewriter' }),
    });
    expect(ass).toContain('\\1a&HFF&');
    expect(ass).toContain('\\1a&H00&');
  });

  it('emits rotation for motion', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: sampleWords,
      style: baseStyle({ animation: 'motion' }),
    });
    expect(ass).toContain('\\frx10');
  });

  it('escapes braces in word text to prevent ASS injection', () => {
    const ass = serializeAss({
      clipWidth: 1080,
      clipHeight: 1920,
      clipStartSeconds: 0,
      clipEndSeconds: 2.5,
      words: [{ word: '{evil}', start: 0.5, end: 1.0 }],
      style: baseStyle(),
    });
    expect(ass).toContain('\\{evil\\}');
  });
});
