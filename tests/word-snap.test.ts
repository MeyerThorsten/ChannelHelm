import { describe, expect, it } from 'vitest';
import {
  type WordTiming,
  flattenTranscriptWords,
  snapToWordBoundary,
  wordsInRange,
} from '@/lib/word-snap';

const W: WordTiming[] = [
  { word: 'Look', start: 0.0, end: 0.28 },
  { word: 'if', start: 0.28, end: 0.48 },
  { word: "you're", start: 0.48, end: 0.78 },
  { word: 'building', start: 0.78, end: 1.18 },
  { word: 'a', start: 1.18, end: 1.25 },
  { word: 'high-power', start: 1.25, end: 1.92 },
  { word: 'machine', start: 1.92, end: 2.4 },
];

describe('snapToWordBoundary', () => {
  it('snaps to nearest word start when side="start"', () => {
    // 0.6 is between "if".end (0.48) and "you're".end (0.78)
    // for side='start', candidate starts are 0.48 and 0.78
    // nearest to 0.6 → 0.48
    expect(snapToWordBoundary(0.6, W, 'start')).toBeCloseTo(0.48);
  });

  it('snaps to nearest word end when side="end"', () => {
    expect(snapToWordBoundary(1.1, W, 'end')).toBeCloseTo(1.18);
  });

  it('returns t unchanged when no words in window', () => {
    expect(snapToWordBoundary(100, W, 'start', 2)).toBe(100);
  });

  it('returns t unchanged on empty words array', () => {
    expect(snapToWordBoundary(0.5, [], 'start')).toBe(0.5);
  });

  it('respects window boundary — does not snap to far-away words', () => {
    // 1.5 with a 0.1 s window: nearest boundary ≥ 1.4 and ≤ 1.6
    // "a".end=1.25 (out), "high-power".start=1.25 (out), "a".start=1.18 (out), "high-power".end=1.92 (out)
    // → nothing in window → return t
    expect(snapToWordBoundary(1.5, W, 'start', 0.1)).toBe(1.5);
  });

  it('snaps exactly to a boundary when t lands on one', () => {
    expect(snapToWordBoundary(0.48, W, 'start')).toBe(0.48);
    expect(snapToWordBoundary(0.48, W, 'end')).toBe(0.48);
  });

  it('chooses earlier boundary on a tie', () => {
    // Tie-break: first one wins (loop replaces only when strictly less).
    const tied: WordTiming[] = [
      { word: 'a', start: 1.0, end: 1.5 },
      { word: 'b', start: 2.0, end: 2.5 },
    ];
    // t=1.75 — equally distant from 1.5 (end of "a") and 2.0 (start of "b")
    // for side='start' candidates are 1.0 and 2.0; |1.75-1.0|=0.75, |1.75-2.0|=0.25 → 2.0
    expect(snapToWordBoundary(1.75, tied, 'start')).toBe(2.0);
  });

  it('handles the start of the array (binary search edge)', () => {
    expect(snapToWordBoundary(0.0, W, 'start')).toBe(0.0);
    expect(snapToWordBoundary(0.05, W, 'start')).toBe(0.0);
  });

  it('handles the end of the array (binary search edge)', () => {
    expect(snapToWordBoundary(2.4, W, 'end')).toBeCloseTo(2.4);
    expect(snapToWordBoundary(2.5, W, 'end', 0.5)).toBeCloseTo(2.4);
  });
});

describe('wordsInRange', () => {
  it('returns words that overlap the range', () => {
    expect(wordsInRange(W, 0.4, 1.2).map((w) => w.word)).toEqual([
      'if',
      "you're",
      'building',
      'a',
    ]);
  });

  it('returns [] for empty/inverted range', () => {
    expect(wordsInRange(W, 1.0, 0.5)).toEqual([]);
    expect(wordsInRange([], 0, 10)).toEqual([]);
  });

  it('includes any word that overlaps the range (start before, end inside)', () => {
    // "building" ends at 1.18 which is past the range start of 1.15 → included
    expect(wordsInRange(W, 1.15, 1.30).map((w) => w.word)).toEqual([
      'building',
      'a',
      'high-power',
    ]);
  });
});

describe('flattenTranscriptWords', () => {
  it('flattens MLX Whisper segments[].words[] shape', () => {
    const transcript = {
      segments: [
        {
          words: [
            { word: ' Look', start: 0.0, end: 0.28, probability: 0.95 },
            { word: ' if', start: 0.28, end: 0.48 },
          ],
        },
        {
          words: [{ word: " you're", start: 0.48, end: 0.78 }],
        },
      ],
    };
    const flat = flattenTranscriptWords(transcript);
    expect(flat).toHaveLength(3);
    expect(flat[0]?.word).toBe('Look'); // leading space stripped
    expect(flat[2]?.start).toBe(0.48);
  });

  it('tolerates missing/malformed entries', () => {
    expect(flattenTranscriptWords(null)).toEqual([]);
    expect(flattenTranscriptWords({})).toEqual([]);
    expect(flattenTranscriptWords({ segments: [{ words: [{}] }] })).toEqual([]);
  });

  it('sorts by start time (defensive)', () => {
    const out = flattenTranscriptWords({
      segments: [
        {
          words: [
            { word: 'b', start: 2.0, end: 2.5 },
            { word: 'a', start: 1.0, end: 1.5 },
          ],
        },
      ],
    });
    expect(out.map((w) => w.word)).toEqual(['a', 'b']);
  });
});
