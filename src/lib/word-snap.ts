/**
 * Word-boundary snapping for the Shorts editor timeline.
 *
 * MLX Whisper emits per-word timestamps (`segments[].words[]` with
 * `{word, start, end}`). When the operator drags a trim handle on the
 * Shorts timeline we want the clip to always begin/end on a whole word
 * — never mid-word. This module is the single source of truth for that
 * snap math; it's used by:
 *
 *   - `src/components/studio/shorts/Timeline.tsx` (client, on drag-end)
 *   - `workers/kinds/clip_render.ts` (server, defensive snap before
 *     ffmpeg `-ss` since the persisted trim might come from a non-UI
 *     source and ffmpeg's seek is itself sub-frame-imprecise)
 *
 * The helper is pure + binary-searchable, so it stays cheap even on
 * 30-minute videos with ~3000 words.
 */

export type WordTiming = {
  word: string;
  start: number;
  end: number;
};

/**
 * Find the index of the first word whose end > t (or words.length when
 * no such word exists). Standard "lower_bound on word.end". Binary
 * search, O(log n).
 */
function firstAfter(words: readonly WordTiming[], t: number): number {
  let lo = 0;
  let hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    // biome-ignore lint/style/noNonNullAssertion: index always in range
    if (words[mid]!.end <= t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Snap a timestamp `t` to the nearest word boundary, considering only
 * words within ±windowSeconds of `t`.
 *
 *   side='start' → return the chosen word's `start` (clip will begin
 *                  cleanly at the start of an audible word)
 *   side='end'   → return the chosen word's `end` (clip will end cleanly
 *                  after a complete word)
 *
 * Returns `t` unchanged when:
 *   - `words` is empty
 *   - no word boundary falls within the window
 *
 * The window default of 2.0 s is comfortable for typical speech (~3
 * words/sec) without ever snapping to a wildly distant word.
 */
export function snapToWordBoundary(
  t: number,
  words: readonly WordTiming[],
  side: 'start' | 'end',
  windowSeconds = 2.0,
): number {
  if (words.length === 0) return t;

  // Candidate boundaries are the side-relevant timestamp of each word
  // within ±windowSeconds. Use binary search to bound the scan.
  const winLo = t - windowSeconds;
  const winHi = t + windowSeconds;

  // First word whose end > winLo — i.e. the earliest word that could
  // be in window (its end might be inside the window even if its
  // start is before).
  let i = firstAfter(words, winLo);
  if (i >= words.length) return t;

  let bestBoundary = Number.NaN;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (; i < words.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index always in range
    const w = words[i]!;
    if (w.start > winHi) break; // past the window upper bound
    const boundary = side === 'start' ? w.start : w.end;
    if (boundary < winLo || boundary > winHi) continue;
    const delta = Math.abs(boundary - t);
    if (delta < bestDelta) {
      bestDelta = delta;
      bestBoundary = boundary;
    }
  }
  return Number.isNaN(bestBoundary) ? t : bestBoundary;
}

/**
 * Return the words that fall (entirely or partially) within `[start, end]`.
 * Used by the editor's transcript panel to highlight which words will
 * actually be in the rendered clip after a trim.
 */
export function wordsInRange(
  words: readonly WordTiming[],
  start: number,
  end: number,
): WordTiming[] {
  if (words.length === 0 || end <= start) return [];
  const out: WordTiming[] = [];
  let i = firstAfter(words, start);
  for (; i < words.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: index always in range
    const w = words[i]!;
    if (w.start >= end) break;
    out.push(w);
  }
  return out;
}

/**
 * Flatten Whisper's `segments[].words[]` JSON shape into a single
 * sorted WordTiming[] array suitable for snapping. Handles the common
 * Whisper quirk where word strings include a leading space.
 */
export function flattenTranscriptWords(transcript: unknown): WordTiming[] {
  const segments =
    (transcript as { segments?: { words?: unknown[] }[] } | undefined)?.segments ?? [];
  const out: WordTiming[] = [];
  for (const seg of segments) {
    if (!seg?.words) continue;
    for (const raw of seg.words) {
      const w = raw as { word?: string; start?: number; end?: number };
      if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
      const word = (w.word ?? '').replace(/^\s+/, '');
      if (!word) continue;
      out.push({ word, start: w.start, end: w.end });
    }
  }
  // MLX Whisper output is already sorted, but defend against the
  // assumption — cheap and stable.
  out.sort((a, b) => a.start - b.start);
  return out;
}
