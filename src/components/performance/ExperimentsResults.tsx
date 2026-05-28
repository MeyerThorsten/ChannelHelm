/**
 * ExperimentsResults — decided A/B experiments with winner + scores.
 * Server component.
 */
import { Card, Eyebrow } from '@/components/ui';
import Link from 'next/link';
import type { ExperimentDecisionResult } from './types';

function kindLabel(kind: string): string {
  if (kind === 'title') return 'Title';
  if (kind === 'thumbnail') return 'Thumbnail';
  if (kind === 'title_thumbnail') return 'Title + Thumb';
  return kind;
}

function metricLabel(metric: string): string {
  if (metric === 'views') return 'Views';
  if (metric === 'impression_ctr') return 'Impression CTR';
  if (metric === 'estimated_minutes_watched') return 'Watch time';
  return metric;
}

function fmtScore(metric: string, score: number | null): string {
  if (score == null) return '—';
  if (metric === 'impression_ctr') {
    const pct = score > 1 ? score : score * 100;
    return `${pct.toFixed(2)}%`;
  }
  if (score >= 1_000_000) return `${(score / 1_000_000).toFixed(1)}M`;
  if (score >= 1_000) return `${(score / 1_000).toFixed(1)}k`;
  return score.toFixed(1);
}

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

export function ExperimentsResults({ experiments }: { experiments: ExperimentDecisionResult[] }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <Eyebrow style={{ marginBottom: 12 }}>A/B results · {experiments.length}</Eyebrow>

      {experiments.length === 0 ? (
        <div
          style={{
            borderRadius: 10,
            border: '1px dashed var(--border)',
            padding: '40px 32px',
            textAlign: 'center',
            color: 'var(--text-faint)',
            fontSize: 13,
            lineHeight: 1.6,
          }}
        >
          <div style={{ fontSize: 24, marginBottom: 8 }}>⚖</div>
          <strong style={{ color: 'var(--text-muted)' }}>No decided experiments yet.</strong>
          <br />
          Start A/B tests from a package&apos;s Content Studio. Decided results show up here.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
            gap: 10,
          }}
        >
          {experiments.map((exp) => (
            <Card key={exp.id} padding={14}>
              {/* Header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span
                  style={{
                    width: 22,
                    height: 22,
                    background: 'color-mix(in oklab, var(--status-published) 14%, transparent)',
                    border:
                      '1px solid color-mix(in oklab, var(--status-published) 30%, transparent)',
                    borderRadius: 5,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 11,
                    color: 'var(--status-published)',
                  }}
                >
                  ✓
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <Link
                    href={`/packages/${exp.packageId}`}
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: 'var(--text)',
                      textDecoration: 'none',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                    }}
                  >
                    {exp.packageTitle}
                  </Link>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                      marginTop: 1,
                    }}
                  >
                    {kindLabel(exp.kind)} · {metricLabel(exp.metric)}
                    {exp.decidedAt && <span> · {fmtDate(exp.decidedAt)}</span>}
                  </div>
                </div>
              </div>

              {/* Variant bars */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {exp.variants.map((v) => {
                  const isWinner = v.label === exp.winnerLabel;
                  const maxScore = Math.max(...exp.variants.map((vv) => vv.score ?? 0), 1);
                  const barWidth = v.score != null ? Math.max(4, (v.score / maxScore) * 100) : 0;

                  return (
                    <div
                      key={v.label}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      {/* Variant label */}
                      <span
                        style={{
                          flexShrink: 0,
                          width: 20,
                          height: 20,
                          borderRadius: 4,
                          background: isWinner ? 'var(--status-published)' : 'var(--bg-elev-2)',
                          color: isWinner ? '#fff' : 'var(--text-muted)',
                          border: '1px solid var(--border)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 10,
                          fontWeight: 700,
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {v.label}
                      </span>

                      {/* Bar */}
                      <div
                        style={{
                          flex: 1,
                          height: 6,
                          borderRadius: 2,
                          background: 'var(--bg-elev-2)',
                          overflow: 'hidden',
                          position: 'relative',
                        }}
                      >
                        <div
                          style={{
                            position: 'absolute',
                            inset: '0 auto 0 0',
                            width: `${barWidth}%`,
                            borderRadius: 2,
                            background: isWinner ? 'var(--status-published)' : 'var(--text-faint)',
                            opacity: isWinner ? 1 : 0.4,
                          }}
                        />
                      </div>

                      {/* Score */}
                      <span
                        style={{
                          flexShrink: 0,
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                          color: isWinner ? 'var(--status-published)' : 'var(--text-faint)',
                          fontWeight: isWinner ? 600 : 400,
                          minWidth: 48,
                          textAlign: 'right',
                        }}
                      >
                        {fmtScore(exp.metric, v.score)}
                        {isWinner && <span style={{ marginLeft: 3, fontSize: 10 }}>✓</span>}
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
