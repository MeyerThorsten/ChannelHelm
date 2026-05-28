'use client';

/**
 * Live subtitle overlay rendered on top of the preview <video>.
 *
 * Mirrors what `serializeAss()` will emit at render time so the operator
 * can preview every styling change without waiting for ffmpeg to burn the
 * subtitles in. Not pixel-perfect against libass — close enough for
 * editorial review. The rendered MP4 stays the source of truth.
 *
 * Position math:
 *   - The overlay lives inside a position:relative wrapper that's the same
 *     size as the <video>. x_pos/y_pos in [0,1] are projected to
 *     percentages directly.
 *   - Font size scales with the wrapper width. ASS font_size is in clip
 *     pixels (clip width = 1080 for vertical / 1920 for horizontal);
 *     scaled to wrapper width via ResizeObserver.
 *
 * Animation parity with `ass-subtitles.ts`:
 *   word_highlight  — render row of N words, current word in highlight color
 *   banner          — same as word_highlight, plus a coloured bar background
 *   pop             — row, current word scaled to 120% briefly
 *   single_word     — just the current word, very large
 *   typewriter      — row; each word fades from alpha 0→1 across its duration
 *   motion          — row; current word adds a slight rotation + colour pulse
 *
 * "Row" matches the ASS emitter — 4 words per row, except single_word = 1.
 */

import type { AssAnimation, AssStyle } from '@/lib/ass-subtitles';
import type { WordTiming } from '@/lib/word-snap';
import { useEffect, useMemo, useRef, useState } from 'react';

const WORDS_PER_ROW = 4;
// Reference clip width the operator's font_size is calibrated against.
// Editor preview is vertical 1080×1920; ASS emit uses the same constant
// when serializing for ffmpeg, so the overlay matches.
const REFERENCE_CLIP_WIDTH = 1080;

export function SubtitleOverlay({
  currentTime,
  trimStart,
  trimEnd,
  words,
  style,
}: {
  /** Absolute time in source seconds (same units as words[].start/.end). */
  currentTime: number;
  trimStart: number;
  trimEnd: number;
  words: readonly WordTiming[];
  style: AssStyle;
}) {
  // Track the wrapper's actual rendered width so we can scale clip-space
  // font sizes to preview pixels. ResizeObserver fires when the preview
  // panel resizes or the column reflows.
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [wrapperWidth, setWrapperWidth] = useState(0);
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    setWrapperWidth(el.offsetWidth);
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWrapperWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Slice + rebase words to the current trim window — out-of-trim words
  // never appear. Memoised because the trim only changes on drag-commit.
  const wordsInTrim = useMemo(() => {
    const inTrim: WordTiming[] = [];
    for (const w of words) {
      if (w.end <= trimStart) continue;
      if (w.start >= trimEnd) break;
      inTrim.push(w);
    }
    return inTrim;
  }, [words, trimStart, trimEnd]);

  // Group into rows of N to match the ASS emitter's line layout.
  const rows = useMemo(() => groupRows(wordsInTrim, style.animation), [
    wordsInTrim,
    style.animation,
  ]);

  // Find the row whose timing brackets the current playhead. Holding the
  // most-recently-ended row across short silences keeps subtitles on
  // screen during natural speech gaps (matches libass behaviour).
  const activeRow = useMemo(() => {
    if (rows.length === 0) return null;
    let best: WordTiming[] | null = null;
    for (const row of rows) {
      const firstStart = row[0]?.start ?? Number.POSITIVE_INFINITY;
      const lastEnd = row[row.length - 1]?.end ?? 0;
      if (currentTime >= firstStart && currentTime < lastEnd + 0.4) {
        best = row;
        break;
      }
      // Otherwise keep the most-recently-passed row so a short pause
      // doesn't blank the subtitles. The next iteration overwrites.
      if (lastEnd <= currentTime) best = row;
      else break;
    }
    return best;
  }, [rows, currentTime]);

  const inWindow = currentTime >= trimStart && currentTime <= trimEnd;
  const hasWords = words.length > 0;
  // Don't render the wrapper at all when we have no words to work with —
  // the editor draws a clearer "missing word timings" warning in that case.
  if (!hasWords) return null;

  const scale = wrapperWidth > 0 ? wrapperWidth / REFERENCE_CLIP_WIDTH : 1;
  const fontSizePx = Math.max(8, Math.round(style.font_size * scale));

  const fontStack = fontFamilyFor(style.font);
  const baseColor = style.font_color;
  const highlightColor = style.highlight_color;

  // Outline + drop shadow mirrors ASS BorderStyle=1 (default).
  // Banner mode drops the outline and uses a solid background instead.
  const textShadow =
    style.animation === 'banner'
      ? 'none'
      : `
        -1px -1px 0 #000,
        1px -1px 0 #000,
        -1px 1px 0 #000,
        1px 1px 0 #000,
        0 2px 6px rgba(0,0,0,0.55)
      `;

  // What to show inside the positioned text box:
  //  - normal case: the active subtitle row
  //  - playhead outside trim: small hint ("[scrub inside trim to preview]")
  //  - no active row (gap between words at this playhead): "…" placeholder
  const textContent = !inWindow
    ? null
    : activeRow && activeRow.length > 0
      ? renderAnimation({
          row: activeRow,
          currentTime,
          style,
          baseColor,
          highlightColor,
          fontSizePx,
        })
      : null;

  return (
    <div
      ref={wrapperRef}
      style={{
        position: 'absolute',
        inset: 0,
        pointerEvents: 'none',
        overflow: 'hidden',
      }}
    >
      {textContent && (
        <div
          style={{
            position: 'absolute',
            left: `${style.x_pos * 100}%`,
            top: `${style.y_pos * 100}%`,
            transform: 'translate(-50%, -50%)',
            maxWidth: '92%',
            textAlign: 'center',
            fontFamily: fontStack,
            fontWeight: 800,
            fontSize: fontSizePx,
            lineHeight: 1.1,
            letterSpacing: '0.01em',
            color: baseColor,
            textShadow,
            whiteSpace: 'nowrap',
            ...(style.animation === 'banner'
              ? {
                  background: highlightColor,
                  color: contrastColorFor(highlightColor),
                  padding: `${Math.round(fontSizePx * 0.18)}px ${Math.round(
                    fontSizePx * 0.45,
                  )}px`,
                  borderRadius: Math.round(fontSizePx * 0.12),
                }
              : {}),
          }}
        >
          {textContent}
        </div>
      )}
      {/* Tiny "live preview" tag so the operator knows this isn't the
          burned-in render. Always visible while words exist — disambiguates
          "overlay is mounted but currently between words" from "overlay
          isn't mounted at all". */}
      <div
        style={{
          position: 'absolute',
          bottom: 6,
          right: 6,
          padding: '2px 6px',
          fontSize: 9,
          fontFamily: 'var(--font-mono)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          color: 'rgba(255,255,255,0.65)',
          background: 'rgba(0,0,0,0.55)',
          borderRadius: 4,
        }}
      >
        live preview · {wordsInTrim.length} word{wordsInTrim.length === 1 ? '' : 's'}
      </div>
    </div>
  );
}

// ─── animation renderers ───────────────────────────────────────────────────

function renderAnimation(opts: {
  row: WordTiming[];
  currentTime: number;
  style: AssStyle;
  baseColor: string;
  highlightColor: string;
  fontSizePx: number;
}) {
  const { row, currentTime, style, baseColor, highlightColor, fontSizePx } = opts;
  switch (style.animation) {
    case 'single_word':
      return renderSingleWord({ row, currentTime, fontSizePx, highlightColor });
    case 'typewriter':
      return renderTypewriter({ row, currentTime, baseColor, highlightColor });
    case 'pop':
      return renderPop({ row, currentTime, baseColor, highlightColor });
    case 'motion':
      return renderMotion({ row, currentTime, baseColor, highlightColor });
    case 'banner':
    case 'word_highlight':
    default:
      return renderWordHighlight({ row, currentTime, baseColor, highlightColor });
  }
}

function renderWordHighlight({
  row,
  currentTime,
  baseColor,
  highlightColor,
}: {
  row: WordTiming[];
  currentTime: number;
  baseColor: string;
  highlightColor: string;
}) {
  return (
    <>
      {row.map((w, i) => {
        const active = currentTime >= w.start && currentTime < w.end;
        return (
          <span
            key={`${i}-${w.start}`}
            style={{
              color: active ? highlightColor : baseColor,
              transition: 'color 80ms linear',
              marginRight: i < row.length - 1 ? '0.32em' : 0,
            }}
          >
            {w.word.trim()}
          </span>
        );
      })}
    </>
  );
}

function renderSingleWord({
  row,
  currentTime,
  fontSizePx,
  highlightColor,
}: {
  row: WordTiming[];
  currentTime: number;
  fontSizePx: number;
  highlightColor: string;
}) {
  // Single-word rows have exactly one word, but defensively pick the
  // current one if multiple ever land here.
  const w = row.find((x) => currentTime >= x.start && currentTime < x.end) ?? row[0];
  if (!w) return null;
  return (
    <span
      style={{
        display: 'inline-block',
        color: highlightColor,
        fontSize: Math.round(fontSizePx * 1.5),
        transform: 'scale(1)',
        transition: 'transform 120ms ease-out',
      }}
    >
      {w.word.trim()}
    </span>
  );
}

function renderTypewriter({
  row,
  currentTime,
  baseColor,
  highlightColor,
}: {
  row: WordTiming[];
  currentTime: number;
  baseColor: string;
  highlightColor: string;
}) {
  return (
    <>
      {row.map((w, i) => {
        // Fade alpha 0 → 1 across the word's duration. After end, full opacity.
        let alpha = 0;
        if (currentTime >= w.start) {
          if (currentTime >= w.end) alpha = 1;
          else alpha = Math.max(0, Math.min(1, (currentTime - w.start) / (w.end - w.start)));
        }
        const active = currentTime >= w.start && currentTime < w.end;
        return (
          <span
            key={`${i}-${w.start}`}
            style={{
              opacity: alpha,
              color: active ? highlightColor : baseColor,
              marginRight: i < row.length - 1 ? '0.32em' : 0,
              transition: 'opacity 60ms linear, color 80ms linear',
            }}
          >
            {w.word.trim()}
          </span>
        );
      })}
    </>
  );
}

function renderPop({
  row,
  currentTime,
  baseColor,
  highlightColor,
}: {
  row: WordTiming[];
  currentTime: number;
  baseColor: string;
  highlightColor: string;
}) {
  return (
    <>
      {row.map((w, i) => {
        const active = currentTime >= w.start && currentTime < w.end;
        const popPhase = active
          ? Math.min(1, (currentTime - w.start) / Math.max(0.05, (w.end - w.start) / 2))
          : 0;
        // Scale 1 → 1.2 → 1 over the word's duration (first half up, second half down).
        const scale =
          active && popPhase < 1
            ? 1 + 0.2 * popPhase
            : active
              ? 1.2 - 0.2 * Math.min(1, (popPhase - 1))
              : 1;
        return (
          <span
            key={`${i}-${w.start}`}
            style={{
              display: 'inline-block',
              color: active ? highlightColor : baseColor,
              transform: `scale(${scale})`,
              transition: 'transform 60ms ease-out, color 80ms linear',
              marginRight: i < row.length - 1 ? '0.32em' : 0,
            }}
          >
            {w.word.trim()}
          </span>
        );
      })}
    </>
  );
}

function renderMotion({
  row,
  currentTime,
  baseColor,
  highlightColor,
}: {
  row: WordTiming[];
  currentTime: number;
  baseColor: string;
  highlightColor: string;
}) {
  return (
    <>
      {row.map((w, i) => {
        const active = currentTime >= w.start && currentTime < w.end;
        return (
          <span
            key={`${i}-${w.start}`}
            style={{
              display: 'inline-block',
              color: active ? highlightColor : baseColor,
              transform: active ? 'rotateX(10deg) translateY(-2px)' : 'rotateX(0) translateY(0)',
              transformOrigin: 'center',
              transition: 'transform 140ms ease-out, color 80ms linear',
              marginRight: i < row.length - 1 ? '0.32em' : 0,
            }}
          >
            {w.word.trim()}
          </span>
        );
      })}
    </>
  );
}

// ─── helpers ───────────────────────────────────────────────────────────────

function groupRows(words: readonly WordTiming[], animation: AssAnimation): WordTiming[][] {
  if (animation === 'single_word') return words.map((w) => [w]);
  const rows: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= WORDS_PER_ROW) {
      rows.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

function fontFamilyFor(font: AssStyle['font']): string {
  // The 6 ASS-targeted fonts. Browsers may not have all of them installed;
  // sane fallbacks keep the preview legible even when libass picks a
  // different glyph set at render time.
  switch (font) {
    case 'Montserrat':
      return '"Montserrat", "Inter", system-ui, sans-serif';
    case 'Poppins':
      return '"Poppins", "Inter", system-ui, sans-serif';
    case 'Roboto':
      return '"Roboto", system-ui, sans-serif';
    case 'Komika':
      return '"Komika Axis", "Bangers", "Impact", sans-serif';
    case 'TheBold':
      return '"TheBoldFont", "Bebas Neue", "Impact", sans-serif';
    case 'Opinion':
      return '"Opinion Pro", "Playfair Display", Georgia, serif';
  }
}

/** Black vs white text against an arbitrary bg hex — banner caption fallback. */
function contrastColorFor(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex);
  if (!m) return '#000';
  const c = m[1] ?? '000000';
  const r = Number.parseInt(c.slice(0, 2), 16);
  const g = Number.parseInt(c.slice(2, 4), 16);
  const b = Number.parseInt(c.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? '#000' : '#fff';
}
