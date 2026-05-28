/**
 * Multi-language subtitle helpers for the Shorts editor.
 *
 * Pure, unit-testable functions that turn a clip's source-language
 * transcript segments + an LLM's translated text into SRT and ASS
 * sidecar files. The server action (`src/server-actions/subtitle-translate.ts`)
 * is the only place that calls the LLM + writes the files; everything
 * here is deterministic so the timing math can be covered by tests.
 *
 * Why SEGMENT-level (not word-level): translation reorders words and
 * changes word counts across languages, so per-word timestamps from
 * MLX Whisper no longer map 1:1 once translated. We therefore key
 * everything off the transcript's SEGMENT boundaries (`segments[].start`
 * / `.end`), which survive translation: line N of the translation
 * occupies the same time window as line N of the source. This is the
 * same contract the `subtitle_translation.v1` prompt enforces (same
 * count, same order).
 *
 * The ASS emitter here reuses `hexToAss` + the position/alignment math
 * shape from `ass-subtitles.ts` but emits ONE dialogue line per segment
 * (a full translated line, shown for the segment's duration) rather than
 * the per-word animated overrides the word-level emitter produces — we
 * only have segment granularity for translated text.
 *
 * DEFERRED (see the contract addendum + server action): burned-in
 * per-language re-render is intentionally NOT wired. The `.ass` file
 * this module emits is the basis for that future work — a clip_render
 * variant would consume it to produce a `rendered_short_clip` per
 * language — but we stop at writing the sidecar.
 */

import { type AssStyle, hexToAss } from './ass-subtitles';

// ─── ISO-639-1 language allow-list ─────────────────────────────────────────

/**
 * Supported target languages (ISO-639-1 code → human label). The label is
 * what we hand the LLM ("Spanish", not "es") since models translate more
 * reliably from a named language than a two-letter code. Kept deliberately
 * small + curated rather than the full ISO table.
 */
export const SUPPORTED_LANGUAGES: Record<string, string> = {
  es: 'Spanish',
  de: 'German',
  fr: 'French',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  tr: 'Turkish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  hi: 'Hindi',
  ar: 'Arabic',
  id: 'Indonesian',
  vi: 'Vietnamese',
  th: 'Thai',
  uk: 'Ukrainian',
};

export function isSupportedLanguage(code: string): boolean {
  return Object.prototype.hasOwnProperty.call(SUPPORTED_LANGUAGES, code);
}

export function languageLabel(code: string): string {
  return SUPPORTED_LANGUAGES[code] ?? code;
}

// ─── segment extraction ────────────────────────────────────────────────────

/** A subtitle segment in clip-local time (rebased so the clip starts at 0). */
export type ClipSegment = {
  /** Clip-local start time in seconds (≥ 0). */
  start: number;
  /** Clip-local end time in seconds (> start). */
  end: number;
  /** Source-language text. */
  text: string;
};

type RawSegment = { start?: unknown; end?: unknown; text?: unknown };

/**
 * Slice the transcript's segments to the clip window `[clipStart, clipEnd]`
 * (in SOURCE seconds) and rebase the timings to clip-local time. A segment
 * is included when it overlaps the window at all; its start/end are clamped
 * to the window before rebasing, so a segment that straddles the boundary
 * still renders for the visible portion.
 *
 * Returns segments sorted by start, with empty-text segments dropped.
 */
export function extractClipSegments(
  transcript: unknown,
  clipStart: number,
  clipEnd: number,
): ClipSegment[] {
  const segments = (transcript as { segments?: unknown } | null | undefined)?.segments;
  if (!Array.isArray(segments) || clipEnd <= clipStart) return [];

  const out: ClipSegment[] = [];
  for (const raw of segments as RawSegment[]) {
    const s = typeof raw.start === 'number' ? raw.start : Number.NaN;
    const e = typeof raw.end === 'number' ? raw.end : Number.NaN;
    const text = typeof raw.text === 'string' ? raw.text.trim() : '';
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    if (!text) continue;
    if (e <= clipStart) continue; // fully before window
    if (s >= clipEnd) continue; // fully after window
    const clampedStart = Math.max(s, clipStart);
    const clampedEnd = Math.min(e, clipEnd);
    if (clampedEnd <= clampedStart) continue;
    out.push({
      start: clampedStart - clipStart,
      end: clampedEnd - clipStart,
      text,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}

// ─── count-mismatch guard ───────────────────────────────────────────────────

/**
 * Reconcile the LLM's translated lines against the source segment count.
 *
 * The prompt instructs the model to return exactly one translated line per
 * input segment, in order. Models occasionally drop/add/merge a line. When
 * the counts don't match we DON'T trust the alignment, so we fall back to
 * the source text for the whole clip (better a correct-but-untranslated
 * caption track than mis-timed translated lines). When the counts DO match
 * we pair them positionally, falling back to source text for any individual
 * blank line.
 *
 * Returns `{ texts, usedFallback }` so callers can record the fallback.
 */
export function reconcileTranslations(
  sourceSegments: readonly ClipSegment[],
  translated: readonly unknown[],
): { texts: string[]; usedFallback: boolean } {
  if (translated.length !== sourceSegments.length) {
    return { texts: sourceSegments.map((s) => s.text), usedFallback: true };
  }
  const texts = sourceSegments.map((s, i) => {
    const t = translated[i];
    const str = typeof t === 'string' ? t.trim() : '';
    return str || s.text; // blank translated line → keep source
  });
  return { texts, usedFallback: false };
}

// ─── SRT emission ───────────────────────────────────────────────────────────

/** SRT time format: `HH:MM:SS,mmm` (comma decimal separator). */
export function formatSrtTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const ms = Math.round(s * 1000);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const sec = Math.floor((ms % 60_000) / 1000);
  const millis = ms % 1000;
  return (
    `${String(h).padStart(2, '0')}:` +
    `${String(m).padStart(2, '0')}:` +
    `${String(sec).padStart(2, '0')},` +
    `${String(millis).padStart(3, '0')}`
  );
}

/**
 * Emit an SRT string. `segments` carry clip-local timing; `texts[i]` is the
 * (already reconciled) caption for segment i. Counts must match — callers run
 * `reconcileTranslations` first. Blank-text cues are skipped.
 */
export function serializeSrt(segments: readonly ClipSegment[], texts: readonly string[]): string {
  const lines: string[] = [];
  let cue = 1;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i]!;
    const text = (texts[i] ?? '').trim();
    if (!text) continue;
    // Guarantee a strictly-increasing, non-zero-length cue window.
    const end = seg.end > seg.start ? seg.end : seg.start + 0.1;
    lines.push(String(cue));
    lines.push(`${formatSrtTime(seg.start)} --> ${formatSrtTime(end)}`);
    lines.push(text);
    lines.push('');
    cue++;
  }
  return lines.join('\n');
}

// ─── ASS emission (segment-level) ───────────────────────────────────────────

const DEFAULT_TRANSLATED_STYLE: AssStyle = {
  font: 'Montserrat',
  font_size: 64,
  font_color: '#FFFFFF',
  highlight_color: '#000000',
  animation: 'banner',
  x_pos: 0.5,
  y_pos: 0.82,
};

/** ASS time format `H:MM:SS.cc` (centiseconds). Mirrors ass-subtitles.ts. */
function formatAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

/** Numpad alignment from x/y position. Mirrors ass-subtitles.ts alignFromPos. */
function alignFromPos(xPos: number, yPos: number): number {
  const col = xPos < 0.34 ? 0 : xPos > 0.66 ? 2 : 1;
  const row = yPos < 0.34 ? 0 : yPos > 0.66 ? 2 : 1;
  const base = row === 2 ? 1 : row === 1 ? 4 : 7;
  return base + col;
}

/** Escape ASS-meaningful characters + collapse newlines into ASS line breaks. */
function escapeAssText(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/\{/g, '\\{')
    .replace(/\}/g, '\\}')
    .replace(/\r?\n/g, '\\N');
}

/**
 * Emit a SEGMENT-level ASS string for a translated caption track. One
 * dialogue line per segment, shown for the segment's clip-local duration.
 *
 * Reuses `hexToAss` (colour byte-order) + the alignment/position math from
 * `ass-subtitles.ts`. Honours an optional `style` block (font/colour/
 * position) so a translated track can match the operator's chosen look;
 * falls back to a readable banner style. Animation tags are NOT applied —
 * we only have segment granularity for translated text (per-word karaoke/
 * pop/etc. need word timings the translation doesn't preserve).
 */
export function serializeTranslatedAss(opts: {
  clipWidth: number;
  clipHeight: number;
  segments: readonly ClipSegment[];
  texts: readonly string[];
  style?: Partial<AssStyle>;
}): string {
  const style: AssStyle = { ...DEFAULT_TRANSLATED_STYLE, ...(opts.style ?? {}) };
  const { clipWidth, clipHeight } = opts;
  const defaultAss = hexToAss(style.font_color);
  const align = alignFromPos(style.x_pos, style.y_pos);
  const posX = Math.round(clipWidth * style.x_pos);
  const posY = Math.round(clipHeight * style.y_pos);

  // Banner styling gets an opaque box behind the text (BorderStyle 4) using
  // the highlight colour; everything else gets an outline + shadow.
  const isBanner = style.animation === 'banner';
  const borderStyle = isBanner ? 4 : 1;
  const backColour = isBanner ? hexToAss(style.highlight_color) : '&H00000000';

  const styleLine =
    `Style: Default,${style.font},${style.font_size},${defaultAss},&H000000FF,&H00000000,${backColour},` +
    `0,0,0,0,100,100,0,0,${borderStyle},2,1,${align},20,20,20,1`;

  const dialogueLines: string[] = [];
  for (let i = 0; i < opts.segments.length; i++) {
    const seg = opts.segments[i]!;
    const text = (opts.texts[i] ?? '').trim();
    if (!text) continue;
    const end = seg.end > seg.start ? seg.end : seg.start + 0.1;
    const body = `{\\pos(${posX},${posY})}${escapeAssText(text)}`;
    dialogueLines.push(
      `Dialogue: 0,${formatAssTime(seg.start)},${formatAssTime(end)},Default,,0,0,0,,${body}`,
    );
  }

  return [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${clipWidth}`,
    `PlayResY: ${clipHeight}`,
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    styleLine,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...dialogueLines,
    '',
  ].join('\n');
}

/**
 * Build the numbered source-line block handed to the translation prompt.
 * One line per segment, prefixed with its 1-based index so the model can
 * keep order; the prompt asks it to return the same count of lines.
 */
export function numberedSourceLines(segments: readonly ClipSegment[]): string {
  return segments.map((s, i) => `${i + 1}. ${s.text.replace(/\s+/g, ' ').trim()}`).join('\n');
}
