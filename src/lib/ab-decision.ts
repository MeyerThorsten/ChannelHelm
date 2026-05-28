/**
 * Pure A/B winner-decision logic for self-run title/thumbnail experiments.
 * Kept side-effect-free so it can be unit-tested without a DB or the YouTube
 * API (mirrors the word-snap / ass-subtitles pattern). The experiment_tick
 * worker feeds it the variants' accumulated observations.
 */
import type { ExperimentObservation, ExperimentVariant } from '@/db/schema/experiments';

export type DecisionMetric = 'views' | 'impression_ctr' | 'estimated_minutes_watched';

export type VariantScore = {
  variantIndex: number;
  label: string;
  score: number; // the aggregated deciding metric (higher = better)
  totalViews: number; // for the min_views guardrail
  cycles: number; // how many full rotation rounds this variant has been observed
};

function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}

/** Views normalized by total window length, so uneven windows compare fairly. */
function viewsPerDay(obs: ExperimentObservation[]): number {
  const days = sum(obs.map((o) => Math.max(o.days, 1)));
  return days > 0 ? sum(obs.map((o) => o.views)) / days : 0;
}

/**
 * Collapse a variant's observations into one comparable score for `metric`.
 * `impression_ctr` uses an impression-weighted average and gracefully falls
 * back to views/day when the channel never reported impressions.
 */
export function scoreVariant(v: ExperimentVariant, metric: DecisionMetric): VariantScore {
  const obs = v.observations ?? [];
  const totalViews = sum(obs.map((o) => o.views));
  let score: number;

  if (metric === 'impression_ctr') {
    const withImp = obs.filter((o) => o.impression_ctr != null && o.impressions != null);
    const imps = sum(withImp.map((o) => o.impressions ?? 0));
    score =
      imps > 0
        ? sum(withImp.map((o) => (o.impression_ctr ?? 0) * (o.impressions ?? 0))) / imps
        : viewsPerDay(obs); // fallback: no impression data on this channel
  } else if (metric === 'estimated_minutes_watched') {
    score = sum(obs.map((o) => o.estimated_minutes_watched ?? 0));
  } else {
    score = viewsPerDay(obs);
  }

  return { variantIndex: v.variant_index, label: v.label, score, totalViews, cycles: obs.length };
}

export type DecisionResult =
  | { decided: false; reason: string; scores: VariantScore[] }
  | { decided: true; winnerVariant: number; scores: VariantScore[] };

/**
 * Decide a winner only when every variant has completed >= `requiredCycles`
 * rotation rounds AND cleared `minViews`. Winner = highest `metric` score,
 * ties broken by total views. Returns a not-decided reason otherwise so the
 * worker keeps rotating.
 */
export function decideWinner(
  variants: ExperimentVariant[],
  opts: { metric: DecisionMetric; requiredCycles: number; minViews: number },
): DecisionResult {
  const scores = variants.map((v) => scoreVariant(v, opts.metric));

  const underObserved = scores.filter((s) => s.cycles < opts.requiredCycles);
  if (underObserved.length > 0) {
    return {
      decided: false,
      reason: `awaiting rotations: ${underObserved.map((s) => s.label).join(', ')}`,
      scores,
    };
  }

  const belowMin = scores.filter((s) => s.totalViews < opts.minViews);
  if (belowMin.length > 0) {
    return {
      decided: false,
      reason: `below min_views (${opts.minViews}): ${belowMin.map((s) => s.label).join(', ')}`,
      scores,
    };
  }

  const ranked = [...scores].sort((a, b) => b.score - a.score || b.totalViews - a.totalViews);
  const top = ranked[0];
  if (!top) return { decided: false, reason: 'no variants', scores };
  return { decided: true, winnerVariant: top.variantIndex, scores: ranked };
}
