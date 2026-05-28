'use client';

/**
 * SentimentSparkline — compact inline SVG emotion-curve for the Studio.
 *
 * Renders a bar-chart sparkline keyed on `score` (emotional intensity), with
 * bar color encoding valence (greenish positive ↔ reddish negative) and bar
 * height encoding the score. Peak windows are highlighted with an accent-color
 * dot above the bar. Each bar carries a tooltip with the time range and the
 * three metric values.
 *
 * Renders nothing when `curve` is absent (pre-sentiment-curve packages).
 */

import type { SentimentCurve, SentimentPoint } from '@/lib/sentiment';

type Props = {
  curve: SentimentCurve | null | undefined;
};

/** Map valence (−1 … 1) to a CSS color using CSS vars. */
function valenceColor(valence: number): string {
  if (valence >= 0.15) {
    // Positive → published-green tinted
    const strength = Math.min(1, valence / 1);
    return `color-mix(in oklab, #10b981 ${Math.round(30 + strength * 55)}%, var(--text-dim))`;
  }
  if (valence <= -0.15) {
    // Negative → failed-red tinted
    const strength = Math.min(1, Math.abs(valence) / 1);
    return `color-mix(in oklab, #ef4444 ${Math.round(30 + strength * 55)}%, var(--text-dim))`;
  }
  // Neutral
  return 'var(--border-strong)';
}

/** Format seconds as m:ss */
function fmtSec(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

export function SentimentSparkline({ curve }: Props) {
  if (!curve || curve.points.length === 0) return null;

  const { points, peak_window_indices } = curve;
  const peakSet = new Set(peak_window_indices);

  // Layout constants
  const W = 340; // total SVG width
  const H = 52; // total SVG height
  const BAR_AREA_H = 40; // height reserved for bars
  const DOT_ZONE_H = 10; // height above bars for peak dots
  const BAR_GAP = 1;
  const n = points.length;
  const barW = Math.max(2, (W - BAR_GAP * (n - 1)) / n);

  // Max score for scaling — avoid flat line if everything is 0
  const maxScore = Math.max(...points.map((p) => p.score), 0.05);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      {/* Header row */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: 0.6,
            color: 'var(--text-faint)',
          }}
        >
          Emotion curve
        </span>
        <Legend />
      </div>

      {/* SVG sparkline */}
      <svg
        width={W}
        height={H}
        viewBox={`0 0 ${W} ${H}`}
        style={{ display: 'block', overflow: 'visible' }}
        aria-label="Emotion intensity over time"
      >
        {points.map((pt, i) => {
          const x = i * (barW + BAR_GAP);
          const barH = Math.max(2, (pt.score / maxScore) * BAR_AREA_H);
          const y = DOT_ZONE_H + (BAR_AREA_H - barH);
          const isPeak = peakSet.has(pt.index);
          const color = valenceColor(pt.valence);
          const dotY = DOT_ZONE_H - 4;

          const tooltip = buildTooltip(pt);

          return (
            <g key={pt.index}>
              {/* Bar */}
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={1}
                fill={color}
                opacity={isPeak ? 1 : 0.7}
              >
                <title>{tooltip}</title>
              </rect>

              {/* Peak dot above the bar */}
              {isPeak && (
                <circle cx={x + barW / 2} cy={dotY} r={2.5} fill="var(--accent)" opacity={0.9}>
                  <title>{tooltip}</title>
                </circle>
              )}
            </g>
          );
        })}

        {/* Baseline */}
        <line
          x1={0}
          y1={DOT_ZONE_H + BAR_AREA_H}
          x2={W}
          y2={DOT_ZONE_H + BAR_AREA_H}
          stroke="var(--border)"
          strokeWidth={1}
        />
      </svg>

      {/* Time axis labels */}
      <TimeAxis points={points} width={W} barW={barW} barGap={BAR_GAP} />

      {/* Summary row */}
      <SummaryRow points={points} peakSet={peakSet} />
    </div>
  );
}

function Legend() {
  const items: { color: string; label: string }[] = [
    { color: '#10b981', label: 'positive' },
    { color: '#ef4444', label: 'negative' },
    { color: 'var(--accent)', label: 'peak' },
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      {items.map(({ color, label }) => (
        <span
          key={label}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            fontSize: 9,
            color: 'var(--text-faint)',
          }}
        >
          <span
            style={{
              width: label === 'peak' ? 5 : 8,
              height: label === 'peak' ? 5 : 5,
              borderRadius: label === 'peak' ? 999 : 1,
              background: color,
              flexShrink: 0,
            }}
          />
          {label}
        </span>
      ))}
    </div>
  );
}

function TimeAxis({
  points,
  width,
  barW,
  barGap,
}: {
  points: SentimentPoint[];
  width: number;
  barW: number;
  barGap: number;
}) {
  if (points.length === 0) return null;
  // Show at most 4 time labels spread across the axis
  const indices = buildAxisIndices(points.length, 4);
  return (
    <div style={{ position: 'relative', height: 12, width }}>
      {indices.map((i) => {
        const pt = points[i];
        if (!pt) return null;
        const x = i * (barW + barGap) + barW / 2;
        return (
          <span
            key={i}
            style={{
              position: 'absolute',
              left: x,
              transform: 'translateX(-50%)',
              fontSize: 8,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text-faint)',
              whiteSpace: 'nowrap',
            }}
          >
            {fmtSec(pt.start)}
          </span>
        );
      })}
    </div>
  );
}

function buildAxisIndices(n: number, max: number): number[] {
  if (n <= max) return Array.from({ length: n }, (_, i) => i);
  const step = (n - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => Math.round(i * step));
}

function SummaryRow({
  points,
  peakSet,
}: {
  points: SentimentPoint[];
  peakSet: Set<number>;
}) {
  if (points.length === 0) return null;

  // Average valence across all points
  const avgValence = points.reduce((s, p) => s + p.valence, 0) / points.length;
  // Highest-score peak point
  const peakPoints = points.filter((p) => peakSet.has(p.index));
  const topPeak = peakPoints.sort((a, b) => b.score - a.score)[0];

  const valenceLabel = avgValence > 0.1 ? 'positive' : avgValence < -0.1 ? 'negative' : 'neutral';
  const valenceColor2 =
    avgValence > 0.1 ? '#10b981' : avgValence < -0.1 ? '#ef4444' : 'var(--text-faint)';

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontSize: 9,
        color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
      }}
    >
      <span>
        tone: <span style={{ color: valenceColor2 }}>{valenceLabel}</span>
      </span>
      <span style={{ color: 'var(--border-strong)' }}>·</span>
      <span>{points.length} windows</span>
      {topPeak && (
        <>
          <span style={{ color: 'var(--border-strong)' }}>·</span>
          <span>
            peak{' '}
            <span style={{ color: 'var(--accent)' }}>
              {fmtSec(topPeak.start)}–{fmtSec(topPeak.end)}
            </span>
          </span>
        </>
      )}
    </div>
  );
}

function buildTooltip(pt: SentimentPoint): string {
  const range = `${fmtSec(pt.start)}–${fmtSec(pt.end)}`;
  const val = pt.valence >= 0 ? `+${pt.valence.toFixed(2)}` : pt.valence.toFixed(2);
  return `${range}  score ${pt.score.toFixed(2)}  valence ${val}  arousal ${pt.arousal.toFixed(2)}`;
}
