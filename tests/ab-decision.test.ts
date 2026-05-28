import type { ExperimentObservation, ExperimentVariant } from '@/db/schema/experiments';
import { decideWinner, scoreVariant } from '@/lib/ab-decision';
import { describe, expect, it } from 'vitest';

function obs(p: Partial<ExperimentObservation>): ExperimentObservation {
  return {
    cycle: 0,
    started_at: '2026-01-01T00:00:00.000Z',
    ended_at: '2026-01-03T00:00:00.000Z',
    days: 2,
    views: 0,
    estimated_minutes_watched: null,
    average_view_percentage: null,
    impressions: null,
    impression_ctr: null,
    ...p,
  };
}

function variant(index: number, observations: ExperimentObservation[]): ExperimentVariant {
  return {
    variant_index: index,
    label: String.fromCharCode(65 + index),
    title: `Title ${index}`,
    observations,
  };
}

describe('scoreVariant', () => {
  it('views metric is normalized per day', () => {
    // 100 views over 2 days = 50/day; 90 views over 1 day = 90/day → B wins.
    const a = scoreVariant(variant(0, [obs({ views: 100, days: 2 })]), 'views');
    const b = scoreVariant(variant(1, [obs({ views: 90, days: 1 })]), 'views');
    expect(a.score).toBe(50);
    expect(b.score).toBe(90);
    expect(a.totalViews).toBe(100);
  });

  it('impression_ctr is impression-weighted', () => {
    const v = variant(0, [
      obs({ impressions: 1000, impression_ctr: 0.02 }),
      obs({ impressions: 3000, impression_ctr: 0.06 }),
    ]);
    // (1000*0.02 + 3000*0.06) / 4000 = (20 + 180)/4000 = 0.05
    expect(scoreVariant(v, 'impression_ctr').score).toBeCloseTo(0.05, 6);
  });

  it('impression_ctr falls back to views/day when no impression data', () => {
    const v = variant(0, [obs({ views: 60, days: 3, impressions: null, impression_ctr: null })]);
    expect(scoreVariant(v, 'impression_ctr').score).toBe(20);
  });

  it('estimated_minutes_watched sums across observations', () => {
    const v = variant(0, [
      obs({ estimated_minutes_watched: 120 }),
      obs({ estimated_minutes_watched: 80 }),
    ]);
    expect(scoreVariant(v, 'estimated_minutes_watched').score).toBe(200);
  });

  it('counts cycles as observation count', () => {
    expect(scoreVariant(variant(0, [obs({}), obs({})]), 'views').cycles).toBe(2);
    expect(scoreVariant(variant(0, []), 'views').cycles).toBe(0);
  });
});

describe('decideWinner', () => {
  const opts = { metric: 'views' as const, requiredCycles: 1, minViews: 50 };

  it('does not decide while a variant is under-observed', () => {
    const r = decideWinner(
      [variant(0, [obs({ views: 100 })]), variant(1, [])], // B never observed
      opts,
    );
    expect(r.decided).toBe(false);
    if (!r.decided) expect(r.reason).toMatch(/awaiting rotations/);
  });

  it('does not decide while a variant is below min_views', () => {
    const r = decideWinner(
      [variant(0, [obs({ views: 100, days: 1 })]), variant(1, [obs({ views: 10, days: 1 })])],
      opts,
    );
    expect(r.decided).toBe(false);
    if (!r.decided) expect(r.reason).toMatch(/below min_views/);
  });

  it('picks the highest-scoring variant', () => {
    const r = decideWinner(
      [variant(0, [obs({ views: 60, days: 1 })]), variant(1, [obs({ views: 200, days: 1 })])],
      opts,
    );
    expect(r.decided).toBe(true);
    if (r.decided) {
      expect(r.winnerVariant).toBe(1);
      expect(r.scores[0]?.variantIndex).toBe(1); // ranked best-first
    }
  });

  it('breaks ties by total views', () => {
    // Same views/day (score) but B has more total views.
    const r = decideWinner(
      [variant(0, [obs({ views: 100, days: 2 })]), variant(1, [obs({ views: 200, days: 4 })])],
      { metric: 'views', requiredCycles: 1, minViews: 50 },
    );
    expect(r.decided).toBe(true);
    if (r.decided) expect(r.winnerVariant).toBe(1);
  });

  it('requires every variant to clear requiredCycles rounds', () => {
    const twoRounds = { metric: 'views' as const, requiredCycles: 2, minViews: 0 };
    const notYet = decideWinner(
      [variant(0, [obs({ views: 100 }), obs({ views: 100 })]), variant(1, [obs({ views: 100 })])],
      twoRounds,
    );
    expect(notYet.decided).toBe(false);

    const done = decideWinner(
      [
        variant(0, [obs({ views: 100, days: 1 }), obs({ views: 100, days: 1 })]),
        variant(1, [obs({ views: 300, days: 1 }), obs({ views: 300, days: 1 })]),
      ],
      twoRounds,
    );
    expect(done.decided).toBe(true);
    if (done.decided) expect(done.winnerVariant).toBe(1);
  });
});
