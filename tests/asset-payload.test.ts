import { readScoredList, scoredListToText } from '@/lib/asset-payload';
import { describe, expect, it } from 'vitest';

describe('readScoredList', () => {
  it('reads the new {text, score} shape', () => {
    const out = readScoredList([
      { text: 'A', score: 95 },
      { text: 'B', score: 80 },
    ]);
    expect(out).toEqual([
      { text: 'A', score: 95 },
      { text: 'B', score: 80 },
    ]);
  });

  it('tolerates the legacy string[] shape (score=null)', () => {
    expect(readScoredList(['x', 'y'])).toEqual([
      { text: 'x', score: null },
      { text: 'y', score: null },
    ]);
  });

  it('handles a mixed array and drops malformed entries', () => {
    const out = readScoredList(['x', { text: 'y', score: 50 }, { score: 10 }, 42, null]);
    expect(out).toEqual([
      { text: 'x', score: null },
      { text: 'y', score: 50 },
    ]);
  });

  it('coerces non-finite scores to null', () => {
    expect(readScoredList([{ text: 'a', score: Number.NaN }])).toEqual([
      { text: 'a', score: null },
    ]);
  });

  it('returns [] for non-arrays', () => {
    expect(readScoredList(undefined)).toEqual([]);
    expect(readScoredList({})).toEqual([]);
  });
});

describe('scoredListToText', () => {
  it('joins text, dropping scores', () => {
    expect(scoredListToText([{ text: 'a', score: 1 }, 'b'])).toBe('a, b');
  });
});
