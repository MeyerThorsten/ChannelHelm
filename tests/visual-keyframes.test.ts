import { describe, expect, it } from 'vitest';
import { pickVlmTimestamps } from '@workers/kinds/analyze_visual';

describe('pickVlmTimestamps', () => {
  it('starts at 0 and ends near the duration', () => {
    const ts = pickVlmTimestamps([], 120);
    expect(ts[0]).toBe(0);
    expect(ts[ts.length - 1]).toBe(119);
  });

  it('uses every scene cut as a keyframe', () => {
    const cuts = [12.4, 38.1, 75.0];
    const ts = pickVlmTimestamps(cuts, 100);
    for (const c of cuts) expect(ts).toContain(c);
  });

  it('returns ~1 frame per 30s for a static video (no cuts)', () => {
    // 5-minute lecture with no scene cuts → ~10–11 keyframes (every 30 s)
    const ts = pickVlmTimestamps([], 300, { maxGapSeconds: 30 });
    expect(ts.length).toBeGreaterThanOrEqual(9);
    expect(ts.length).toBeLessThanOrEqual(12);
  });

  it('fills long gaps between scene cuts', () => {
    // 90-second gap between cuts at 10 and 100 should get interpolations
    const ts = pickVlmTimestamps([10, 100], 150, { maxGapSeconds: 30 });
    const between = ts.filter((t) => t > 10 && t < 100);
    expect(between.length).toBeGreaterThanOrEqual(2); // at least 40s, 70s-ish
  });

  it('returns sorted, deduped timestamps', () => {
    const ts = pickVlmTimestamps([5, 5.1, 5.2, 5.3, 60], 120, { minSpacing: 0.5 });
    // sorted
    for (let i = 1; i < ts.length; i++) {
      expect(ts[i]! >= ts[i - 1]!).toBe(true);
    }
    // deduped (cuts within 0.5s collapse to one)
    expect(ts.filter((t) => Math.abs(t - 5) < 0.5).length).toBe(1);
  });

  it('drops scene cuts past the duration', () => {
    const ts = pickVlmTimestamps([10, 999], 60);
    expect(ts).toContain(10);
    expect(ts).not.toContain(999);
  });

  it('handles a video with one frame', () => {
    const ts = pickVlmTimestamps([], 1);
    expect(ts).toEqual([0]); // outro skipped when duration ≤ 1
  });

  it('produces ~20–35 timestamps for a typical 8-min, 20-cut tutorial', () => {
    const cuts = Array.from({ length: 20 }, (_, i) => 20 + i * 22); // 20 cuts spread over the run
    const ts = pickVlmTimestamps(cuts, 8 * 60);
    expect(ts.length).toBeGreaterThanOrEqual(20);
    expect(ts.length).toBeLessThanOrEqual(35);
  });
});
