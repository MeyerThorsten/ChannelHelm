'use client';

// ChannelHelm UI primitives — ported from the Claude Design handoff (ui.jsx).
// Inline styles + CSS vars so they track the dark/light theme exactly.

import type { CSSProperties, ReactNode } from 'react';

type StatusMeta = { label: string; color: string };
export const STATUS_META: Record<string, StatusMeta> = {
  draft: { label: 'Draft', color: 'var(--status-draft)' },
  analyzing: { label: 'Analyzing', color: 'var(--status-analyzing)' },
  analyzed: { label: 'Analyzed', color: 'var(--status-analyzing)' },
  ready_for_review: { label: 'Ready', color: 'var(--status-ready)' },
  approved: { label: 'Approved', color: 'var(--status-approved)' },
  dispatching: { label: 'Dispatching', color: 'var(--status-approved)' },
  scheduled: { label: 'Scheduled', color: 'var(--status-scheduled)' },
  published: { label: 'Published', color: 'var(--status-published)' },
  failed: { label: 'Failed', color: 'var(--status-failed)' },
  rejected: { label: 'Rejected', color: 'var(--text-faint)' },
  // job statuses
  running: { label: 'Running', color: 'var(--status-analyzing)' },
  pending: { label: 'Pending', color: 'var(--text-faint)' },
  queued: { label: 'Queued', color: 'var(--text-faint)' },
  done: { label: 'Done', color: 'var(--status-published)' },
  succeeded: { label: 'Succeeded', color: 'var(--status-published)' },
};

const PULSING = new Set(['analyzing', 'running', 'dispatching']);
const STATUS_FALLBACK: StatusMeta = { label: 'Draft', color: 'var(--status-draft)' };

export function StatusPill({
  status,
  animated,
  size = 'md',
}: {
  status: string;
  animated?: boolean;
  size?: 'sm' | 'md';
}) {
  const m = STATUS_META[status] ?? STATUS_FALLBACK;
  const pulse = animated || PULSING.has(status);
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: size === 'sm' ? '2px 6px 2px 5px' : '3px 8px 3px 7px',
        fontSize: size === 'sm' ? 10 : 11,
        fontWeight: 500,
        color: m.color,
        background: `color-mix(in oklab, ${m.color} 12%, transparent)`,
        border: `1px solid color-mix(in oklab, ${m.color} 24%, transparent)`,
        borderRadius: 999,
        whiteSpace: 'nowrap',
        letterSpacing: 0.1,
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: m.color,
          animation: pulse ? 'pulse-soft 1.6s ease-in-out infinite' : 'none',
          boxShadow: pulse ? `0 0 0 3px color-mix(in oklab, ${m.color} 20%, transparent)` : 'none',
        }}
      />
      {m.label}
    </span>
  );
}

export function ScorePill({ score, size = 'md' }: { score: number; size?: 'sm' | 'md' }) {
  let bg: string;
  let fg: string;
  if (score >= 90) {
    bg = 'color-mix(in oklab, var(--accent) 14%, transparent)';
    fg = 'var(--accent)';
  } else if (score >= 80) {
    bg = 'color-mix(in oklab, var(--status-analyzing) 14%, transparent)';
    fg = 'var(--status-analyzing)';
  } else if (score >= 70) {
    bg = 'color-mix(in oklab, var(--status-ready) 14%, transparent)';
    fg = 'var(--status-ready)';
  } else {
    bg = 'color-mix(in oklab, var(--text-faint) 16%, transparent)';
    fg = 'var(--text-faint)';
  }
  const isSm = size === 'sm';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 2,
        padding: isSm ? '1px 5px' : '2px 7px',
        fontSize: isSm ? 10 : 11,
        fontFamily: 'var(--font-mono)',
        fontFeatureSettings: '"tnum"',
        fontWeight: 500,
        color: fg,
        background: bg,
        borderRadius: 4,
        letterSpacing: -0.2,
      }}
    >
      {score}
      <span style={{ opacity: 0.5, fontSize: isSm ? 8 : 9 }}>/100</span>
    </span>
  );
}

export function Eyebrow({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="uppercase-eyebrow" style={style}>
      {children}
    </div>
  );
}

export function IconBtn({
  children,
  onClick,
  active,
  title,
  style,
}: {
  children: ReactNode;
  onClick?: () => void;
  active?: boolean;
  title?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        width: 28,
        height: 28,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: active ? 'var(--bg-hover)' : 'transparent',
        color: active ? 'var(--text)' : 'var(--text-muted)',
        border: '1px solid',
        borderColor: active ? 'var(--border)' : 'transparent',
        borderRadius: 6,
        transition: 'background 0.12s, color 0.12s',
        cursor: 'pointer',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'var(--bg-hover)';
          e.currentTarget.style.color = 'var(--text)';
        }
      }}
      onMouseLeave={(e) => {
        if (!active) {
          e.currentTarget.style.background = 'transparent';
          e.currentTarget.style.color = 'var(--text-muted)';
        }
      }}
    >
      {children}
    </button>
  );
}

export function GhostBtn({
  children,
  onClick,
  icon,
  size = 'md',
  style,
  danger,
  disabled,
  type = 'button',
  title,
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  style?: CSSProperties;
  danger?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
  title?: string;
}) {
  const isSm = size === 'sm';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: isSm ? '4px 8px' : '6px 10px',
        fontSize: isSm ? 11 : 12,
        fontWeight: 500,
        color: disabled ? 'var(--text-dim)' : danger ? 'var(--status-failed)' : 'var(--text)',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        transition: 'all 0.12s',
        opacity: disabled ? 0.6 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-hover)';
      }}
      onMouseLeave={(e) => {
        if (!disabled) e.currentTarget.style.background = 'var(--bg-elev)';
      }}
    >
      {icon && <span style={{ opacity: 0.7, fontSize: isSm ? 11 : 12 }}>{icon}</span>}
      {children}
    </button>
  );
}

export function PrimaryBtn({
  children,
  onClick,
  icon,
  size = 'md',
  style,
  loading,
  disabled,
  type = 'button',
}: {
  children: ReactNode;
  onClick?: () => void;
  icon?: ReactNode;
  size?: 'sm' | 'md';
  style?: CSSProperties;
  loading?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  const isSm = size === 'sm';
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: isSm ? '4px 10px' : '7px 12px',
        fontSize: isSm ? 11 : 12,
        fontWeight: 600,
        color: '#fff',
        background: 'var(--accent)',
        border: '1px solid color-mix(in oklab, var(--accent) 80%, white)',
        borderRadius: 6,
        boxShadow: '0 0 0 1px var(--accent-glow), 0 1px 0 rgba(255,255,255,0.18) inset',
        opacity: disabled ? 0.5 : 1,
        transition: 'transform 0.06s, filter 0.12s',
        cursor: disabled || loading ? 'not-allowed' : 'pointer',
        ...style,
      }}
      onMouseEnter={(e) => {
        if (!disabled && !loading) e.currentTarget.style.filter = 'brightness(1.08)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.filter = 'brightness(1)';
      }}
    >
      {loading ? <span className="spinner" /> : icon && <span>{icon}</span>}
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
  padding = 16,
  hoverable,
  onClick,
}: {
  children: ReactNode;
  style?: CSSProperties;
  padding?: number;
  hoverable?: boolean;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius)',
        padding,
        transition: 'border-color 0.12s, background 0.12s',
        cursor: onClick ? 'pointer' : 'default',
        ...style,
      }}
      onMouseEnter={
        hoverable
          ? (e) => {
              e.currentTarget.style.borderColor = 'var(--border-strong)';
            }
          : undefined
      }
      onMouseLeave={
        hoverable
          ? (e) => {
              e.currentTarget.style.borderColor = 'var(--border)';
            }
          : undefined
      }
    >
      {children}
    </div>
  );
}

export function Avatar({
  glyph,
  color,
  size = 28,
}: {
  glyph: ReactNode;
  color?: string;
  size?: number;
}) {
  const c = color || 'var(--accent)';
  return (
    <span
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: `color-mix(in oklab, ${c} 22%, transparent)`,
        color: c,
        border: `1px solid color-mix(in oklab, ${c} 40%, transparent)`,
        borderRadius: 6,
        fontFamily: 'var(--font-mono)',
        fontWeight: 600,
        fontSize: size <= 22 ? 9 : 11,
        letterSpacing: 0.2,
        flexShrink: 0,
      }}
    >
      {glyph}
    </span>
  );
}

export type PipelineProgress = {
  audio: number;
  visual: number;
  fusion: number;
  intelligence: number;
};
const PIPELINE_LAYERS = [
  { key: 'audio', label: 'Audio', glyph: '♬' },
  { key: 'visual', label: 'Visual', glyph: '▦' },
  { key: 'fusion', label: 'Fusion', glyph: '⌘' },
  { key: 'intelligence', label: 'Intelligence', glyph: '✦' },
] as const;

export function Pipeline({
  progress,
  compact,
  layout = 'row',
}: {
  progress: PipelineProgress;
  compact?: boolean;
  layout?: 'row' | 'col';
}) {
  if (compact) {
    return (
      <div style={{ display: 'inline-flex', gap: 3, alignItems: 'center' }}>
        {PIPELINE_LAYERS.map((l) => {
          const v = progress[l.key];
          return (
            <span
              key={l.key}
              title={`${l.label}: ${Math.round(v * 100)}%`}
              style={{
                width: 18,
                height: 4,
                borderRadius: 1,
                background:
                  v >= 1
                    ? 'var(--status-published)'
                    : v > 0
                      ? 'var(--status-analyzing)'
                      : 'var(--border)',
                position: 'relative',
                overflow: 'hidden',
              }}
            >
              {v > 0 && v < 1 && (
                <span
                  style={{
                    position: 'absolute',
                    inset: '0 auto 0 0',
                    width: `${v * 100}%`,
                    background: 'var(--status-analyzing)',
                    animation: 'pulse-soft 1.6s ease-in-out infinite',
                  }}
                />
              )}
            </span>
          );
        })}
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: layout === 'col' ? 'column' : 'row',
        gap: layout === 'col' ? 8 : 0,
        alignItems: layout === 'col' ? 'stretch' : 'center',
      }}
    >
      {PIPELINE_LAYERS.map((l, i) => {
        const v = progress[l.key];
        const done = v >= 1;
        const running = v > 0 && v < 1;
        const idle = v === 0;
        const next = PIPELINE_LAYERS[i + 1];
        const nextStarted = next ? progress[next.key] > 0 : false;
        return (
          <div key={l.key} style={{ display: 'contents' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flex: layout === 'col' ? '0 0 auto' : 1,
                minWidth: 0,
              }}
            >
              <span
                style={{
                  width: 22,
                  height: 22,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 4,
                  fontSize: 11,
                  fontFamily: 'var(--font-mono)',
                  color: done
                    ? 'var(--status-published)'
                    : running
                      ? 'var(--status-analyzing)'
                      : 'var(--text-dim)',
                  background: done
                    ? 'color-mix(in oklab, var(--status-published) 14%, transparent)'
                    : running
                      ? 'color-mix(in oklab, var(--status-analyzing) 14%, transparent)'
                      : 'var(--bg-elev-2)',
                  border: `1px solid ${
                    done
                      ? 'color-mix(in oklab, var(--status-published) 30%, transparent)'
                      : running
                        ? 'color-mix(in oklab, var(--status-analyzing) 30%, transparent)'
                        : 'var(--border)'
                  }`,
                }}
              >
                {done ? (
                  '✓'
                ) : running ? (
                  <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1 }} />
                ) : (
                  l.glyph
                )}
              </span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1, minWidth: 0 }}>
                <span
                  style={{
                    fontSize: 11,
                    color: idle ? 'var(--text-dim)' : 'var(--text)',
                    fontWeight: 500,
                  }}
                >
                  {l.label}
                </span>
                <span
                  style={{
                    fontSize: 10,
                    color: 'var(--text-faint)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {done ? 'ready' : running ? `${Math.round(v * 100)}%` : '—'}
                </span>
              </div>
            </div>
            {layout === 'row' && i < PIPELINE_LAYERS.length - 1 && (
              <span
                style={{
                  height: 1,
                  flex: 1,
                  margin: '0 8px',
                  background: nextStarted || done ? 'var(--accent)' : 'var(--border)',
                  opacity: nextStarted || done ? 0.6 : 1,
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

const PLATFORM_META: Record<string, { icon: string; color: string }> = {
  youtube: { icon: '▶', color: '#FF0033' },
  shorts: { icon: '✂', color: '#FF0033' },
  clips: { icon: '▦', color: '#0EA5E9' },
  blog: { icon: '📄', color: '#A78BFA' },
  x: { icon: '𝕏', color: '#F4F4F5' },
  linkedin: { icon: 'in', color: '#0A66C2' },
  instagram: { icon: '◎', color: '#E1306C' },
  facebook: { icon: 'f', color: '#1877F2' },
  tiktok: { icon: '♪', color: '#69C9D0' },
  threads: { icon: '@', color: '#F4F4F5' },
  pinterest: { icon: 'P', color: '#E60023' },
  reddit: { icon: 'r', color: '#FF4500' },
  bluesky: { icon: '☁', color: '#1185FE' },
  telegram: { icon: '✈', color: '#26A5E4' },
  snapchat: { icon: '👻', color: '#FFFC00' },
  google_business: { icon: '⌂', color: '#4285F4' },
  whatsapp: { icon: '✆', color: '#25D366' },
  discord: { icon: '🎮', color: '#5865F2' },
};

export function PlatformIcon({
  platform,
  size = 18,
  active,
}: {
  platform: string;
  size?: number;
  active?: boolean;
}) {
  const p = PLATFORM_META[platform] ?? { icon: '◆', color: 'var(--text)' };
  return (
    <span
      style={{
        width: size,
        height: size,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: 4,
        background: active
          ? `color-mix(in oklab, ${p.color} 22%, transparent)`
          : 'var(--bg-elev-2)',
        border: `1px solid ${active ? `color-mix(in oklab, ${p.color} 40%, transparent)` : 'var(--border)'}`,
        color: active ? p.color : 'var(--text-muted)',
        fontSize: size <= 14 ? 9 : 10,
        fontFamily: p.icon.length > 1 ? 'var(--font-mono)' : 'inherit',
        fontWeight: 600,
        flexShrink: 0,
      }}
    >
      {p.icon}
    </span>
  );
}

const THUMB_PALETTES = [
  { bg1: '#0EA5E9', bg2: '#082F49' },
  { bg1: '#F59E0B', bg2: '#451A03' },
  { bg1: '#10B981', bg2: '#022C22' },
  { bg1: '#A855F7', bg2: '#2E1065' },
  { bg1: '#EF4444', bg2: '#450A0A' },
  { bg1: '#14B8A6', bg2: '#042F2E' },
  { bg1: '#EAB308', bg2: '#422006' },
];

export function MockThumb({
  seed = 1,
  style,
  label,
}: {
  seed?: number;
  style?: CSSProperties;
  label?: string;
}) {
  const p = THUMB_PALETTES[seed % THUMB_PALETTES.length] as (typeof THUMB_PALETTES)[number];
  return (
    <div
      style={{
        background: `linear-gradient(135deg, ${p.bg2}, ${p.bg1})`,
        color: '#fff',
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
    >
      <svg
        width="100%"
        height="100%"
        style={{ position: 'absolute', inset: 0, opacity: 0.18 }}
        preserveAspectRatio="none"
        viewBox="0 0 100 60"
        aria-hidden
      >
        {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
          <path
            key={i}
            d={`M0,${10 + i * 8} Q25,${5 + i * 8} 50,${10 + i * 8} T100,${10 + i * 8}`}
            stroke="white"
            strokeWidth="0.3"
            fill="none"
          />
        ))}
      </svg>
      {label && (
        <div
          style={{
            position: 'absolute',
            left: 8,
            bottom: 6,
            fontSize: 9,
            fontFamily: 'var(--font-mono)',
            letterSpacing: 0.4,
            opacity: 0.8,
          }}
        >
          {label}
        </div>
      )}
    </div>
  );
}
