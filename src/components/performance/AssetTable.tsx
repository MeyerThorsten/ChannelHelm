/**
 * AssetTable — recently dispatched/published assets with their latest metrics.
 * Server component.
 */
import { Eyebrow, PlatformIcon, StatusPill } from '@/components/ui';
import Link from 'next/link';
import type { PerformanceAsset } from './types';

function fmtVal(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function fmtPct(n: number | null): string {
  if (n == null) return '—';
  const pct = n > 1 ? n : n * 100;
  return `${pct.toFixed(1)}%`;
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function assetTypeLabel(t: string): string {
  return t.replace(/_/g, ' ');
}

const TH_STYLE: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 500,
  color: 'var(--text-faint)',
  textTransform: 'uppercase',
  letterSpacing: 0.6,
  padding: '8px 10px',
  borderBottom: '1px solid var(--border)',
  textAlign: 'left',
  whiteSpace: 'nowrap',
};

const TD_STYLE: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text)',
  padding: '10px 10px',
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'middle',
};

const MONO: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
};

export function AssetTable({ assets }: { assets: PerformanceAsset[] }) {
  return (
    <div style={{ marginBottom: 40 }}>
      <Eyebrow style={{ marginBottom: 12 }}>
        Dispatched &amp; published assets · {assets.length}
      </Eyebrow>

      {assets.length === 0 ? (
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
          <div style={{ fontSize: 24, marginBottom: 8 }}>📡</div>
          <strong style={{ color: 'var(--text-muted)' }}>No performance data yet.</strong>
          <br />
          Once assets are dispatched and signal collection runs, their metrics will appear here.
        </div>
      ) : (
        <div
          style={{
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 10,
            overflow: 'hidden',
          }}
        >
          <table
            style={{
              width: '100%',
              borderCollapse: 'collapse',
            }}
          >
            <thead>
              <tr>
                <th style={TH_STYLE}>Package / Asset</th>
                <th style={TH_STYLE}>Type</th>
                <th style={TH_STYLE}>Platform</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Views / Impr.</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Engagement</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>CTR</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Retention</th>
                <th style={{ ...TH_STYLE, textAlign: 'right' }}>Sampled</th>
                <th style={TH_STYLE}>Status</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => {
                const sig = a.signals;
                const reach = sig.views ?? sig.impressions;
                return (
                  <tr key={a.id} style={{ transition: 'background 0.1s' }} onMouseEnter={undefined}>
                    {/* Package / Asset */}
                    <td style={TD_STYLE}>
                      <Link
                        href={`/packages/${a.packageId}`}
                        style={{
                          color: 'var(--text)',
                          textDecoration: 'none',
                          display: 'block',
                        }}
                      >
                        <div
                          style={{
                            fontWeight: 500,
                            fontSize: 12,
                            whiteSpace: 'nowrap',
                            overflow: 'hidden',
                            textOverflow: 'ellipsis',
                            maxWidth: 240,
                          }}
                        >
                          {a.packageTitle}
                        </div>
                        <div
                          style={{
                            ...MONO,
                            color: 'var(--text-faint)',
                            fontSize: 10,
                            marginTop: 1,
                          }}
                        >
                          {a.brandName} · {a.id.slice(0, 16)}
                        </div>
                      </Link>
                    </td>

                    {/* Type */}
                    <td style={TD_STYLE}>
                      <span
                        style={{
                          ...MONO,
                          fontSize: 10,
                          color: 'var(--text-muted)',
                          padding: '2px 6px',
                          background: 'var(--bg-elev-2)',
                          border: '1px solid var(--border)',
                          borderRadius: 4,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {assetTypeLabel(a.type)}
                      </span>
                    </td>

                    {/* Platform */}
                    <td style={TD_STYLE}>
                      {a.platform ? (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                          <PlatformIcon platform={a.platform} size={16} active />
                          <span style={{ ...MONO, fontSize: 10, color: 'var(--text-muted)' }}>
                            {a.platform}
                          </span>
                        </div>
                      ) : (
                        <span style={{ ...MONO, color: 'var(--text-faint)' }}>—</span>
                      )}
                    </td>

                    {/* Views / Impressions */}
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      <span style={MONO}>{fmtVal(reach)}</span>
                    </td>

                    {/* Engagement */}
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      <span style={MONO}>{fmtVal(sig.engagement)}</span>
                    </td>

                    {/* CTR */}
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      {sig.ctr != null ? (
                        <span
                          style={{
                            ...MONO,
                            color:
                              (sig.ctr > 1 ? sig.ctr : sig.ctr * 100) >= 4
                                ? 'var(--status-published)'
                                : (sig.ctr > 1 ? sig.ctr : sig.ctr * 100) >= 2
                                  ? 'var(--status-ready)'
                                  : 'var(--text)',
                          }}
                        >
                          {fmtPct(sig.ctr)}
                        </span>
                      ) : (
                        <span style={{ ...MONO, color: 'var(--text-faint)' }}>—</span>
                      )}
                    </td>

                    {/* Avg view % (retention) */}
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      {sig.avgViewPct != null ? (
                        <span
                          style={{
                            ...MONO,
                            color:
                              (sig.avgViewPct > 1 ? sig.avgViewPct : sig.avgViewPct * 100) >= 40
                                ? 'var(--status-published)'
                                : (sig.avgViewPct > 1 ? sig.avgViewPct : sig.avgViewPct * 100) >= 25
                                  ? 'var(--status-ready)'
                                  : 'var(--text)',
                          }}
                        >
                          {fmtPct(sig.avgViewPct)}
                        </span>
                      ) : (
                        <span style={{ ...MONO, color: 'var(--text-faint)' }}>—</span>
                      )}
                    </td>

                    {/* Sampled at */}
                    <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                      <span style={{ ...MONO, fontSize: 10, color: 'var(--text-faint)' }}>
                        {sig.lastSampledAt ? fmtDate(sig.lastSampledAt) : '—'}
                      </span>
                    </td>

                    {/* Status */}
                    <td style={TD_STYLE}>
                      <StatusPill status={a.status} size="sm" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
