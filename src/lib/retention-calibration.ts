/**
 * Retention calibration (v1.5). The LLM predicts which windows hold attention;
 * we turn that into a predicted "engaging fraction" (high-retention windows ÷
 * total windows) and learn, per brand, how that maps to the REAL average view
 * percentage YouTube reports (via collect_signal). A simple least-squares line
 * corrects future predictions toward measured reality. Pure + unit-tested; the
 * "model" is just {a, b} — deliberately light, not a heavy ML model.
 */

export type CalibrationSample = {
  predicted: number; // 0..1 predicted engaging fraction
  actual: number; // 0..1 measured average view fraction
};

export type CalibrationModel = {
  a: number; // slope
  b: number; // intercept
  n: number; // samples used
  fitted: boolean; // false ⇒ identity (not enough data)
};

export const IDENTITY: CalibrationModel = { a: 1, b: 0, n: 0, fitted: false };

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/**
 * Fit `actual ≈ a·predicted + b` by ordinary least squares. Returns identity
 * (pass-through) when there are fewer than `minSamples`. When all predicted
 * values are equal (zero variance), falls back to predicting the mean actual.
 */
export function fitCalibration(samples: CalibrationSample[], minSamples = 3): CalibrationModel {
  const clean = samples.filter((s) => Number.isFinite(s.predicted) && Number.isFinite(s.actual));
  const n = clean.length;
  if (n < minSamples) return { ...IDENTITY, n };

  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sxx = 0;
  for (const s of clean) {
    sx += s.predicted;
    sy += s.actual;
    sxy += s.predicted * s.actual;
    sxx += s.predicted * s.predicted;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-9) {
    // No spread in predictions → best guess is the mean actual.
    return { a: 0, b: sy / n, n, fitted: true };
  }
  const a = (n * sxy - sx * sy) / denom;
  const b = (sy - a * sx) / n;
  return { a, b, n, fitted: true };
}

/** Map a predicted fraction through the calibration, clamped to 0..1. */
export function applyCalibration(predicted: number, model: CalibrationModel): number {
  if (!model.fitted) return clamp01(predicted);
  return clamp01(model.a * predicted + model.b);
}

/**
 * Predicted engaging fraction from an analysis' retention block: the share of
 * scene-log windows the LLM flagged as high-retention. Returns null when the
 * inputs are missing so callers can skip calibration.
 */
export function predictedRetentionFraction(
  highRetentionWindowCount: number,
  totalWindowCount: number,
): number | null {
  if (!Number.isFinite(totalWindowCount) || totalWindowCount <= 0) return null;
  return clamp01(highRetentionWindowCount / totalWindowCount);
}
