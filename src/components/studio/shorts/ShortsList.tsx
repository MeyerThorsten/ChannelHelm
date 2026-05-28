'use client';

/**
 * Replaces the generic JSON-card PlatformAssets render for the Shorts tab.
 *
 * One card per `clip_index` collapsing the plan's editable metadata with
 * the rendered asset's preview (when present). Each card shows:
 *   - 9:16 video preview (or a placeholder while the render is pending)
 *   - title · hook score · duration · status pill
 *   - description (collapsed to 3 lines)
 *   - tags (chips)
 *   - actions: Edit / Render-or-Re-render / Publish / Delete
 *
 * The Publish button opens the new Modal primitive with ClipPublishOptions
 * inside; on success the card refreshes via router.refresh().
 */

import { Modal } from '@/components/ui/Modal';
import { deleteClip, renderClip } from '@/server-actions/clip-edit';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import type { ShortClipRow } from '../StudioShell';
import { ClipPublishOptions } from './ClipPublishOptions';

export function ShortsList({
  packageId,
  rows,
}: {
  packageId: string;
  rows: ShortClipRow[];
}) {
  if (rows.length === 0) {
    return (
      <div
        style={{
          padding: '40px 24px',
          textAlign: 'center',
          background: 'var(--panel)',
          border: '1px dashed var(--border-strong)',
          borderRadius: 10,
          color: 'var(--text-faint)',
          fontSize: 13,
        }}
      >
        No Shorts yet. The pipeline generates these as part of analyze_intelligence —
        if the package is still running, they'll appear here when ready.
      </div>
    );
  }

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 12,
        overflow: 'hidden',
      }}
    >
      <header
        style={{
          padding: '14px 18px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
        }}
      >
        <div>
          <span
            style={{
              fontSize: 10,
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
              textTransform: 'uppercase',
              letterSpacing: '0.06em',
              marginRight: 8,
            }}
          >
            ✨ Shorts
          </span>
          <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>{rows.length} clips</span>
        </div>
      </header>
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {rows.map((r) => (
          <ShortRow key={`${r.planAssetId}:${r.clipIndex}`} packageId={packageId} row={r} />
        ))}
      </div>
    </div>
  );
}

function ShortRow({ packageId, row }: { packageId: string; row: ShortClipRow }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [publishOpen, setPublishOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const plan = row.plan as {
    title?: string;
    description?: string;
    tags?: string[];
    caption?: string;
    hook_score?: number;
    start?: number;
    end?: number;
    trim?: { start: number; end: number };
    pending_render?: boolean;
    publish_options?: {
      platforms?: { youtube?: boolean; tiktok?: boolean; instagram?: boolean };
      privacy?: 'public' | 'unlisted' | 'private' | 'schedule';
      publish_at?: string;
    };
  };
  const tStart = plan.trim?.start ?? plan.start ?? 0;
  const tEnd = plan.trim?.end ?? plan.end ?? 0;
  const dur = row.rendered?.durationSeconds ?? Math.max(0, tEnd - tStart);
  const hookPct =
    typeof plan.hook_score === 'number' ? Math.round(plan.hook_score * 100) : null;
  const isRendered = !!row.rendered?.videoUrl;
  const isRendering = !!plan.pending_render;
  const renderedStatus = row.rendered?.status ?? null;

  function doRender(): void {
    setError(null);
    start(async () => {
      try {
        await renderClip(row.planAssetId, row.clipIndex);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  function doDelete(): void {
    if (
      !confirm(`Delete this Short? Removes the plan entry${isRendered ? ' and rendered file' : ''}.`)
    ) {
      return;
    }
    setError(null);
    start(async () => {
      try {
        await deleteClip(row.planAssetId, row.clipIndex);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '180px 1fr',
        gap: 16,
        padding: 18,
        borderTop: '1px solid var(--border)',
      }}
    >
      {/* Preview column */}
      <div
        style={{
          width: 180,
          height: 320,
          background: '#0c0c0d',
          borderRadius: 9,
          border: '1px solid var(--border-strong)',
          overflow: 'hidden',
          position: 'relative',
        }}
      >
        {isRendered ? (
          <video
            src={row.rendered?.videoUrl ?? undefined}
            controls
            preload="metadata"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'column',
              gap: 8,
              color: 'var(--text-faint)',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              padding: 12,
              textAlign: 'center',
            }}
          >
            {isRendering ? (
              <>
                <span style={{ fontSize: 24 }}>⏳</span>
                <span>rendering…</span>
              </>
            ) : (
              <>
                <span style={{ fontSize: 24, opacity: 0.5 }}>✂</span>
                <span style={{ opacity: 0.6 }}>not rendered yet</span>
              </>
            )}
          </div>
        )}
        {hookPct != null && (
          <span
            style={{
              position: 'absolute',
              top: 6,
              right: 6,
              padding: '2px 7px',
              borderRadius: 5,
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              background: hookPct >= 90 ? '#10b981' : hookPct >= 75 ? '#0ea5e9' : '#52525b',
              color: 'white',
            }}
          >
            ★ {hookPct}
          </span>
        )}
      </div>

      {/* Body column */}
      <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
          <h3
            style={{
              margin: 0,
              fontSize: 16,
              fontWeight: 600,
              color: 'var(--text)',
              lineHeight: 1.3,
            }}
          >
            {plan.title || `Clip ${row.clipIndex + 1}`}
          </h3>
          {renderedStatus && (
            <span
              style={{
                fontSize: 10,
                padding: '2px 7px',
                borderRadius: 999,
                fontFamily: 'var(--font-mono)',
                color: pillColour(renderedStatus),
                background: `color-mix(in oklab, ${pillColour(renderedStatus)} 14%, transparent)`,
                border: `1px solid color-mix(in oklab, ${pillColour(renderedStatus)} 30%, transparent)`,
              }}
            >
              {renderedStatus}
            </span>
          )}
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {formatDur(dur)}
          </span>
        </div>

        {plan.description && (
          <p
            style={{
              margin: '4px 0 0',
              fontSize: 13,
              color: 'var(--text-muted)',
              lineHeight: 1.55,
              display: '-webkit-box',
              WebkitLineClamp: 3,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {plan.description}
          </p>
        )}

        {plan.tags && plan.tags.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexWrap: 'wrap',
              gap: 5,
              marginTop: 4,
            }}
          >
            {plan.tags.slice(0, 10).map((t, i) => (
              <span
                key={`${t}-${i}`}
                style={{
                  fontSize: 11,
                  padding: '2px 7px',
                  background: 'var(--panel-2)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 4,
                  color: 'var(--text-muted)',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                #{t}
              </span>
            ))}
          </div>
        )}

        <div style={{ flex: 1 }} />

        <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
          <a
            href={`/packages/${packageId}/shorts/${row.clipIndex}`}
            style={btnStyle('ghost')}
          >
            ✎ Edit
          </a>
          <button
            type="button"
            disabled={pending || isRendering}
            onClick={doRender}
            style={btnStyle(isRendered ? 'ghost' : 'primary')}
          >
            {isRendering ? '⏳ Rendering…' : isRendered ? '↺ Re-render' : '▶ Render'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={() => setPublishOpen(true)}
            style={btnStyle('primary')}
          >
            ↗ Publish
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={doDelete}
            style={btnStyle('danger')}
          >
            🗑 Delete
          </button>
        </div>

        {error && (
          <p
            style={{
              margin: '6px 0 0',
              fontSize: 12,
              color: 'var(--status-failed)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {error}
          </p>
        )}
      </div>

      <Modal open={publishOpen} onClose={() => setPublishOpen(false)} title="Publish Short">
        <ClipPublishOptions
          planAssetId={row.planAssetId}
          clipIndex={row.clipIndex}
          renderedAssetId={row.rendered?.id ?? null}
          initialPlatforms={plan.publish_options?.platforms ?? {}}
          initialPrivacy={plan.publish_options?.privacy ?? 'private'}
          initialPublishAt={plan.publish_options?.publish_at ?? null}
          onDone={() => {
            setPublishOpen(false);
            router.refresh();
          }}
        />
      </Modal>
    </div>
  );
}

// ─── small helpers ────────────────────────────────────────────────────────

function formatDur(seconds: number): string {
  if (!seconds || seconds < 0) return '—';
  const s = Math.round(seconds);
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function pillColour(status: string): string {
  switch (status) {
    case 'ready_for_review':
      return 'var(--status-ready)';
    case 'approved':
    case 'dispatching':
      return 'var(--status-approved)';
    case 'dispatched':
    case 'published':
      return 'var(--status-published)';
    case 'failed':
    case 'rejected':
      return 'var(--status-failed)';
    default:
      return 'var(--text-faint)';
  }
}

function btnStyle(kind: 'primary' | 'ghost' | 'danger'): React.CSSProperties {
  if (kind === 'primary') {
    return {
      padding: '6px 12px',
      fontSize: 12,
      fontWeight: 600,
      background: 'var(--accent)',
      color: '#fff',
      border: '1px solid color-mix(in oklab, var(--accent) 80%, white)',
      borderRadius: 6,
      cursor: 'pointer',
      textDecoration: 'none',
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
    };
  }
  if (kind === 'danger') {
    return {
      padding: '6px 12px',
      fontSize: 12,
      background: 'transparent',
      color: 'var(--status-failed)',
      border: '1px solid color-mix(in oklab, var(--status-failed) 30%, var(--border))',
      borderRadius: 6,
      cursor: 'pointer',
    };
  }
  return {
    padding: '6px 12px',
    fontSize: 12,
    background: 'var(--panel-2)',
    color: 'var(--text)',
    border: '1px solid var(--border-strong)',
    borderRadius: 6,
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
  };
}
