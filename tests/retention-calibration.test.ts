import {
  applyCalibration,
  fitCalibration,
  predictedRetentionFraction,
} from '@/lib/retention-calibration';
import { describe, expect, it } from 'vitest';

describe('fitCalibration', () => {
  it('returns identity below the minimum sample count', () => {
    const m = fitCalibration([{ predicted: 0.5, actual: 0.3 }], 3);
    expect(m.fitted).toBe(false);
    expect(applyCalibration(0.42, m)).toBeCloseTo(0.42, 6);
  });

  it('recovers a known linear relationship (actual = 0.5·predicted + 0.1)', () => {
    const samples = [0.2, 0.4, 0.6, 0.8].map((p) => ({ predicted: p, actual: 0.5 * p + 0.1 }));
    const m = fitCalibration(samples);
    expect(m.fitted).toBe(true);
    expect(m.a).toBeCloseTo(0.5, 4);
    expect(m.b).toBeCloseTo(0.1, 4);
    expect(applyCalibration(1.0, m)).toBeCloseTo(0.6, 4);
  });

  it('corrects an over-optimistic predictor downward', () => {
    // The LLM flags ~70% as high-retention but real average view % is ~35%.
    const samples = [
      { predicted: 0.6, actual: 0.3 },
      { predicted: 0.7, actual: 0.35 },
      { predicted: 0.8, actual: 0.4 },
      { predicted: 0.9, actual: 0.45 },
    ];
    const m = fitCalibration(samples);
    expect(applyCalibration(0.7, m)).toBeLessThan(0.7);
    expect(applyCalibration(0.7, m)).toBeCloseTo(0.35, 2);
  });

  it('falls back to the mean actual when predictions have no spread', () => {
    const samples = [
      { predicted: 0.5, actual: 0.2 },
      { predicted: 0.5, actual: 0.4 },
      { predicted: 0.5, actual: 0.6 },
    ];
    const m = fitCalibration(samples);
    expect(m.a).toBe(0);
    expect(applyCalibration(0.5, m)).toBeCloseTo(0.4, 6); // mean of 0.2,0.4,0.6
  });

  it('clamps calibrated output to 0..1', () => {
    const samples = [
      { predicted: 0.1, actual: 0.0 },
      { predicted: 0.5, actual: 0.9 },
      { predicted: 0.9, actual: 1.0 },
    ];
    const m = fitCalibration(samples);
    expect(applyCalibration(2, m)).toBeLessThanOrEqual(1);
    expect(applyCalibration(-1, m)).toBeGreaterThanOrEqual(0);
  });
});

describe('predictedRetentionFraction', () => {
  it('is the high-retention share of windows', () => {
    expect(predictedRetentionFraction(3, 12)).toBeCloseTo(0.25, 6);
  });
  it('clamps and guards bad inputs', () => {
    expect(predictedRetentionFraction(20, 10)).toBe(1);
    expect(predictedRetentionFraction(1, 0)).toBeNull();
  });
});
