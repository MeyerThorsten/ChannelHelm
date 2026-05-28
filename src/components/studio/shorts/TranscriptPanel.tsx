'use client';

/**
 * Word-by-word transcript that:
 *   - Highlights only the words inside [trimStart, trimEnd] (the words
 *     that will be in the rendered clip).
 *   - Bolds the word at the current playhead (the word being spoken
 *     right now during preview playback).
 *   - Auto-scrolls so the playhead word stays centred (debounced).
 *   - Clicking a word seeks the playhead to that word's start.
 */

import type { WordTiming } from '@/lib/word-snap';
import { useEffect, useRef } from 'react';

export function TranscriptPanel({
  words,
  trimStart,
  trimEnd,
  currentTime,
  onSeek,
}: {
  words: readonly WordTiming[];
  trimStart: number;
  trimEnd: number;
  currentTime: number;
  onSeek: (t: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const activeIdxRef = useRef<number>(-1);
  const lastScrollRef = useRef<number>(0);

  // Find the word currently being spoken.
  let activeIdx = -1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (!w) continue;
    if (currentTime >= w.start && currentTime < w.end) {
      activeIdx = i;
      break;
    }
    if (w.start > currentTime) break;
  }

  // Debounced auto-scroll: only when the active word changes AND we
  // haven't scrolled in the last 150ms (avoids fighting the user's
  // manual scroll).
  useEffect(() => {
    if (activeIdx === activeIdxRef.current) return;
    activeIdxRef.current = activeIdx;
    if (activeIdx < 0) return;
    if (Date.now() - lastScrollRef.current < 150) return;
    const el = containerRef.current?.querySelector(`[data-word-idx="${activeIdx}"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      lastScrollRef.current = Date.now();
    }
  }, [activeIdx]);

  if (words.length === 0) {
    return (
      <div
        style={{
          padding: 20,
          textAlign: 'center',
          color: 'var(--text-faint)',
          fontSize: 13,
          fontFamily: 'var(--font-mono)',
        }}
      >
        No word-level transcript available. Re-run the pipeline to enable word-snap.
      </div>
    );
  }

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <div
          style={{
            fontSize: 10,
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            textTransform: 'uppercase',
            letterSpacing: '0.06em',
          }}
        >
          Transcript
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          click word to seek · highlighted words are inside the trim
        </div>
      </div>
      <div
        ref={containerRef}
        style={{
          background: 'var(--panel-2)',
          border: '1px solid var(--border-strong)',
          borderRadius: 8,
          padding: '14px 16px',
          maxHeight: 200,
          overflowY: 'auto',
          lineHeight: 1.9,
          fontSize: 14,
          color: 'var(--text-muted)',
        }}
      >
        {words.map((w, i) => {
          const inTrim = w.start >= trimStart && w.end <= trimEnd;
          const isActive = i === activeIdx;
          return (
            <span
              key={`${w.start}-${i}`}
              data-word-idx={i}
              onClick={() => onSeek(w.start)}
              style={{
                display: 'inline-block',
                padding: '1px 4px',
                margin: '1px 1px',
                borderRadius: 3,
                cursor: 'pointer',
                color: inTrim ? 'var(--text)' : 'var(--text-faint)',
                background: isActive
                  ? 'color-mix(in oklab, var(--accent) 28%, transparent)'
                  : 'transparent',
                fontWeight: isActive ? 600 : inTrim ? 500 : 400,
                transition: 'background 0.1s',
              }}
            >
              {w.word}
            </span>
          );
        })}
      </div>
    </div>
  );
}
