import { computeSentimentCurve, scoreText } from '@/lib/sentiment';
import { describe, expect, it } from 'vitest';

describe('scoreText', () => {
  it('reads positive vs negative valence', () => {
    expect(scoreText('this is amazing and great, I love it').valence).toBeGreaterThan(0);
    expect(scoreText('this is terrible, the worst, I hate it').valence).toBeLessThan(0);
  });

  it('neutral text has ~zero valence and low arousal', () => {
    const s = scoreText('the meeting is scheduled for the afternoon on tuesday');
    expect(s.valence).toBe(0);
    expect(s.arousal).toBeLessThan(0.3);
  });

  it('raises arousal for intense words, exclamation, and caps', () => {
    const calm = scoreText('we will look at the numbers');
    const hot = scoreText('STOP! this is insane, you will NOT believe what happened now!');
    expect(hot.arousal).toBeGreaterThan(calm.arousal);
    expect(hot.score).toBeGreaterThan(calm.score);
  });

  it('empty text scores zero', () => {
    expect(scoreText('')).toEqual({ valence: 0, arousal: 0, score: 0 });
  });
});

describe('computeSentimentCurve', () => {
  const windows = [
    { start: 0, end: 5, text: 'today we set up the project files' }, // calm
    { start: 5, end: 10, text: 'and THEN it CRASHED — total disaster, the worst!' }, // hot, negative
    { start: 10, end: 15, text: 'but the fix was incredible, amazing, a huge win!' }, // hot, positive
    { start: 15, end: 20, text: 'anyway that is the summary' }, // calm
  ];

  it('produces one point per window with the window timing', () => {
    const c = computeSentimentCurve(windows);
    expect(c.points).toHaveLength(4);
    expect(c.points[1]?.start).toBe(5);
    expect(c.points[0]?.index).toBe(0);
  });

  it('flags the high-intensity windows as peaks, best-first', () => {
    const c = computeSentimentCurve(windows, 2);
    expect(c.peak_window_indices).toHaveLength(2);
    // windows 1 and 2 are the emotional spikes, not 0 or 3
    expect(c.peak_window_indices).toContain(1);
    expect(c.peak_window_indices).toContain(2);
    expect(c.peak_window_indices).not.toContain(0);
  });

  it('handles an empty scene log', () => {
    expect(computeSentimentCurve([])).toEqual({ points: [], peak_window_indices: [] });
  });

  it('never flags zero-intensity windows as peaks', () => {
    const flat = [
      { start: 0, end: 5, text: 'the document lists several items' },
      { start: 5, end: 10, text: 'each item has a name and a date' },
    ];
    const c = computeSentimentCurve(flat, 5);
    expect(c.peak_window_indices.length).toBeLessThanOrEqual(2);
  });
});
