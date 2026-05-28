/**
 * SummaryStrip — top-line metrics per brand on the /performance page.
 * Server component (no 'use client' needed — pure rendering).
 */
import { Avatar, Card, Eyebrow } from '@/components/ui';
import { brandColor } from '@/lib/brand-color';
import type { BrandSummary } from './types';

function MetricCell({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        minWidth: 0,
      }}
    >
      <span
        style={{
          fontSize: 10,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: 0.6,
          fontWeight: 500,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
      <span
        style={{
          fontSize: 20,
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          color: 'var(--text)',
          letterSpacing: -0.5,
          lineHeight: 1.1,
        }}
      >
        {value}
      </span>
      {sub && (
        <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          {sub}
        </span>
      )}
    </div>
  );
}

function formatCount(n: number | null): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString();
}

function formatPct(n: number | null): string {
  if (n == null) return '—';
  // CTR from signals is stored as 0..1 fraction from YouTube, or 0..100 from Zernio
  // Guard: if > 1 it was stored as percentage already
  const pct = n > 1 ? n : n * 100;
  return `${pct.toFixed(1)}%`;
}

export function SummaryStrip({ brands }: { brands: BrandSummary[] }) {
  if (brands.length === 0) {
    return null;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
      <Eyebrow>Overview</Eyebrow>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${Math.min(brands.length, 3)}, 1fr)`,
          gap: 12,
        }}
      >
        {brands.map((b) => {
          const color = brandColor(b.slug);
          return (
            <Card key={b.id} padding={16}>
              {/* Brand header */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 }}>
                <Avatar glyph={b.slug.slice(0, 2).toUpperCase()} color={color} size={26} />
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>{b.name}</div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {b.slug}
                  </div>
                </div>
              </div>

              {/* Metrics grid */}
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(4, 1fr)',
                  gap: 12,
                  paddingTop: 12,
                  borderTop: '1px solid var(--border)',
                }}
              >
                <MetricCell label="Published" value={String(b.publishedCount)} sub="assets" />
                <MetricCell label="Reach" value={formatCount(b.totalReach)} sub="views / impr." />
                <MetricCell label="Avg CTR" value={formatPct(b.avgCtr)} />
                <MetricCell label="Avg Retention" value={formatPct(b.avgViewPct)} />
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
