'use client';

/**
 * Interactive timeline for the Shorts editor.
 *
 * Visible elements (left → right, scaled to the WIDER source video range
 * around the trim, with ~3s of context on each side):
 *
 *   ┌─────────────────────────────────────────┐
 *   │ words tick marks (light)                │  ← word boundaries
 *   │ ▒▒▒▒▒[──── playhead ────]▒▒▒▒▒          │  ← shaded outside trim, playhead bar inside
 *   │       ↑                  ↑              │
 *   │   start handle       end handle         │
 *   └─────────────────────────────────────────┘
 *
 * Interactions:
 *   - Drag a trim handle horizontally → updates draftStart/draftEnd in
 *     parent state. On drag-END, snaps to the nearest word boundary via
 *     `snapToWordBoundary` and commits via `onTrimCommit`.
 *   - Click anywhere on the track (not a handle) → seeks the playhead
 *     via `onSeek`.
 *
 * Trim values are in source-video seconds (NOT clip-local).
 *
 * The "window" shown on screen is the trim ± 3 seconds (or the full clip
 * if the trim is short), so the operator has visual context around their
 * boundaries.
 */

import { type WordTiming, snapToWordBoundary } from '@/lib/word-snap';
import { useEffect, useMemo, useRef, useState } from 'react';

export function Timeline({
  trimStart,
  trimEnd,
  currentTime,
  sourceDuration,
  words,
  onTrimChange,
  onTrimCommit,
  onSeek,
}: {
  trimStart: number;
  trimEnd: number;
  currentTime: number;
  sourceDuration: number;
  words: readonly WordTiming[];
  /** Called continuously during drag — for live ghost preview. */
  onTrimChange: (next: { start: number; end: number }) => void;
  /** Called on drag-end with the snapped final values. */
  onTrimCommit: (next: { start: number; end: number }) => void;
  onSeek: (t: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [drag, setDrag] = useState<{
    side: 'start' | 'end';
    rawTime: number; // unsnapped, current pointer position
  } | null>(null);

  // The visible window — slightly wider than the trim for context.
  // Recomputed on each trim change (cheap).
  const window = useMemo(() => {
    const pad = 3.0;
    const winStart = Math.max(0, Math.min(trimStart, trimEnd) - pad);
    const winEnd = Math.min(sourceDuration, Math.max(trimStart, trimEnd) + pad);
    return { winStart, winEnd, span: Math.max(0.001, winEnd - winStart) };
  }, [trimStart, trimEnd, sourceDuration]);

  function pctOf(t: number): number {
    return ((t - window.winStart) / window.span) * 100;
  }

  function pointerTimeFromEvent(clientX: number): number {
    const el = containerRef.current;
    if (!el) return trimStart;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left;
    const pct = Math.max(0, Math.min(1, x / rect.width));
    return window.winStart + pct * window.span;
  }

  // Drag handlers — attach on document while dragging so the cursor can
  // leave the track without dropping the drag.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const t = pointerTimeFromEvent(e.clientX);
      setDrag((d) => (d ? { ...d, rawTime: t } : d));
      if (drag.side === 'start') {
        const safeEnd = Math.max(trimEnd, t + 0.2);
        onTrimChange({ start: Math.max(0, t), end: safeEnd });
      } else {
        const safeStart = Math.min(trimStart, t - 0.2);
        onTrimChange({ start: Math.max(0, safeStart), end: Math.min(sourceDuration, t) });
      }
    };
    const onUp = () => {
      const finalRaw = drag.rawTime;
      const snapped = snapToWordBoundary(finalRaw, words, drag.side);
      if (drag.side === 'start') {
        const finalStart = Math.max(0, Math.min(snapped, trimEnd - 0.2));
        onTrimCommit({ start: finalStart, end: trimEnd });
      } else {
        const finalEnd = Math.max(trimStart + 0.2, Math.min(snapped, sourceDuration));
        onTrimCommit({ start: trimStart, end: finalEnd });
      }
      setDrag(null);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag?.side]); // re-bind only when which handle is being dragged

  // Compute the snap target while dragging — used for the visual guide
  // line so the operator can see where it WILL snap to before releasing.
  const snapGuide = drag ? snapToWordBoundary(drag.rawTime, words, drag.side) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          fontSize: 11,
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span>{formatTs(window.winStart)}</span>
        <span style={{ color: 'var(--text-muted)' }}>
          trim {formatTs(trimStart)}–{formatTs(trimEnd)} · clip{' '}
          {formatTs(trimEnd - trimStart)}
        </span>
        <span>{formatTs(window.winEnd)}</span>
      </div>

      <div
        ref={containerRef}
        onClick={(e) => {
          // Ignore clicks on the handles — those start drags.
          const target = e.target as HTMLElement;
          if (target.dataset?.role === 'handle') return;
          const t = pointerTimeFromEvent(e.clientX);
          if (t >= trimStart && t <= trimEnd) onSeek(t);
        }}
        style={{
          position: 'relative',
          width: '100%',
          height: 56,
          background: 'var(--panel-2)',
          border: '1px solid var(--border-strong)',
          borderRadius: 7,
          userSelect: 'none',
          cursor: 'pointer',
        }}
      >
        {/* word-boundary tick marks */}
        {words.map((w, i) => {
          if (w.start < window.winStart || w.start > window.winEnd) return null;
          return (
            <span
              key={`w-${i}`}
              style={{
                position: 'absolute',
                left: `${pctOf(w.start)}%`,
                top: 8,
                bottom: 8,
                width: 1,
                background: 'rgba(255,255,255,0.06)',
                pointerEvents: 'none',
              }}
            />
          );
        })}

        {/* shaded "out of trim" regions */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            left: 0,
            width: `${pctOf(trimStart)}%`,
            background: 'rgba(0,0,0,0.55)',
            pointerEvents: 'none',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            left: `${pctOf(trimEnd)}%`,
            background: 'rgba(0,0,0,0.55)',
            pointerEvents: 'none',
          }}
        />

        {/* trim region overlay */}
        <div
          style={{
            position: 'absolute',
            top: 4,
            bottom: 4,
            left: `${pctOf(trimStart)}%`,
            width: `${pctOf(trimEnd) - pctOf(trimStart)}%`,
            background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
            border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)',
            borderRadius: 5,
            pointerEvents: 'none',
          }}
        />

        {/* snap guide during drag */}
        {snapGuide != null && (
          <span
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${pctOf(snapGuide)}%`,
              width: 2,
              background: 'var(--accent)',
              opacity: 0.85,
              pointerEvents: 'none',
            }}
          />
        )}

        {/* playhead */}
        {currentTime >= window.winStart && currentTime <= window.winEnd && (
          <span
            style={{
              position: 'absolute',
              top: 0,
              bottom: 0,
              left: `${pctOf(currentTime)}%`,
              width: 2,
              background: '#ff0033',
              pointerEvents: 'none',
            }}
          />
        )}

        {/* start handle */}
        <Handle side="start" pct={pctOf(trimStart)} onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          setDrag({ side: 'start', rawTime: trimStart });
        }} />
        {/* end handle */}
        <Handle side="end" pct={pctOf(trimEnd)} onPointerDown={(e) => {
          (e.target as Element).setPointerCapture(e.pointerId);
          setDrag({ side: 'end', rawTime: trimEnd });
        }} />
      </div>

      <p
        style={{
          margin: 0,
          fontSize: 11,
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        Drag a handle to retrim · snaps to the nearest whole word on release · click the track to seek
      </p>
    </div>
  );
}

function Handle({
  side,
  pct,
  onPointerDown,
}: {
  side: 'start' | 'end';
  pct: number;
  onPointerDown: (e: React.PointerEvent) => void;
}) {
  return (
    <span
      data-role="handle"
      onPointerDown={onPointerDown}
      style={{
        position: 'absolute',
        top: -4,
        bottom: -4,
        left: `calc(${pct}% - 6px)`,
        width: 12,
        background: 'var(--accent)',
        border: '1px solid color-mix(in oklab, var(--accent) 75%, white)',
        borderRadius: 3,
        cursor: 'ew-resize',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.4)',
        title: side,
      } as React.CSSProperties}
    />
  );
}

function formatTs(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const s = Math.round(seconds * 10) / 10; // one decimal
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
