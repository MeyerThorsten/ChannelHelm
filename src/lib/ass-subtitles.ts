/**
 * ASS (Advanced SubStation Alpha) subtitle file emitter.
 *
 * Replaces the simple VTT emitter for the Shorts editor — ASS gives us
 * inline styling overrides (colour, position, animation tags) that VTT
 * doesn't support. Consumed by ffmpeg via the `subtitles=` filter:
 *
 *     -vf "subtitles=clip_000.ass"
 *
 * The same ffmpeg call shape works for either VTT or ASS; the only
 * thing that changes is the file extension and the file contents.
 *
 * Six animation styles are supported; each maps to ASS override tags
 * applied per-word. Word timings are sourced from MLX Whisper's
 * `segments[].words[]` array, then sliced to the clip's `[start, end]`
 * window and re-baselined to clip-local time before emit.
 *
 * Style overrides applied per-dialogue-line use the V4+ event Format
 * field of `Dialogue: Layer, Start, End, Style, …, Text`.
 */

import type { WordTiming } from './word-snap';

export type AssFont =
  | 'Montserrat'
  | 'Poppins'
  | 'Roboto'
  | 'Komika'
  | 'TheBold'
  | 'Opinion';

export type AssAnimation =
  | 'word_highlight'
  | 'banner'
  | 'pop'
  | 'single_word'
  | 'typewriter'
  | 'motion';

export type AssStyle = {
  font: AssFont;
  font_size: number; // px — also used as ASS font size
  font_color: string; // #RRGGBB
  highlight_color: string; // #RRGGBB
  animation: AssAnimation;
  /** 0..1 in clip coords (0 = left, 1 = right). */
  x_pos: number;
  /** 0..1 in clip coords (0 = top, 1 = bottom). */
  y_pos: number;
};

export type AssRenderOpts = {
  /** Clip resolution. Required so absolute pixel positions can be derived from x_pos/y_pos. */
  clipWidth: number;
  clipHeight: number;
  /** Clip start time in source seconds. Word timings are baselined to clip-local time. */
  clipStartSeconds: number;
  /** Clip end time in source seconds. */
  clipEndSeconds: number;
  /** Words from the source transcript (any range — we slice + rebase to clip-local). */
  words: readonly WordTiming[];
  /** Styling block — drives font / animation / colours / position. */
  style: AssStyle;
};

// ─── colour conversion ─────────────────────────────────────────────────────

/**
 * ASS Colour is stored as `&H<AA><BB><GG><RR>` (alpha first, then BGR — the
 * opposite byte order from web hex). Returns the canonical
 * `&H00BBGGRR` form with the alpha byte set to 00 (fully opaque).
 *
 * Examples:
 *   #FF0000 (red) → &H000000FF
 *   #00FF00 (green) → &H0000FF00
 *   #FFFFFF → &H00FFFFFF
 */
export function hexToAss(hex: string): string {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) {
    // Default to white on parse failure rather than throwing — keeps
    // operator typos from breaking renders.
    return '&H00FFFFFF';
  }
  // biome-ignore lint/style/noNonNullAssertion: regex match guarantees capture
  const rgb = m[1]!.toUpperCase();
  const r = rgb.slice(0, 2);
  const g = rgb.slice(2, 4);
  const b = rgb.slice(4, 6);
  return `&H00${b}${g}${r}`;
}

// ─── ASS time format ───────────────────────────────────────────────────────

/** ASS time format is `H:MM:SS.cc` (centiseconds, single-digit hours). */
function fmtAssTime(seconds: number): string {
  const s = Math.max(0, seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const cs = Math.round((sec - Math.floor(sec)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ─── alignment from x_pos / y_pos quadrant ─────────────────────────────────

/**
 * ASS numpad alignment values:
 *   7 8 9    top-left, top-centre, top-right
 *   4 5 6    middle-left, centre, middle-right
 *   1 2 3    bottom-left, bottom-centre, bottom-right
 *
 * For our editor we use absolute positioning via `\pos(x,y)` in each
 * dialogue line, so the default \an value mostly affects fallback
 * behaviour — but we still pick a sensible quadrant from x_pos/y_pos
 * so the wrap point + multi-line stacking direction look right.
 */
function alignFromPos(xPos: number, yPos: number): number {
  const col = xPos < 0.34 ? 0 : xPos > 0.66 ? 2 : 1; // 0=left, 1=centre, 2=right
  const row = yPos < 0.34 ? 0 : yPos > 0.66 ? 2 : 1; // 0=top, 1=middle, 2=bottom
  // numpad: bottom row is 1/2/3, middle is 4/5/6, top is 7/8/9
  const base = row === 2 ? 1 : row === 1 ? 4 : 7;
  return base + col;
}

// ─── animation tag generators ──────────────────────────────────────────────

/**
 * Build the inline ASS override tag block for a word.
 *
 *   wordIdx          — index of this word within the dialogue line
 *   wordCount        — total words in the dialogue line
 *   wordDurMs        — word duration in milliseconds (for \t durations)
 *   highlightAss     — pre-converted highlight colour (&H form)
 *   defaultAss       — pre-converted default font colour (&H form)
 *   animation        — which animation style is active
 *
 * Returns a string like "{\1c&H00FFFFFF&\t(0,150,\fscx120\fscy120)}" to
 * be prepended to the word text in the Dialogue Text field. May return
 * an empty string when an animation needs nothing per-word.
 */
function animationTagsForWord(opts: {
  wordIdx: number;
  wordCount: number;
  wordDurMs: number;
  highlightAss: string;
  defaultAss: string;
  animation: AssAnimation;
}): string {
  const { wordIdx, wordDurMs, highlightAss, defaultAss, animation } = opts;
  switch (animation) {
    case 'word_highlight': {
      // Karaoke fill: per-word \k tag (centiseconds). Each word stays in
      // place; the highlight colour sweeps across them as time passes.
      const ds = Math.max(1, Math.round(wordDurMs / 10));
      return `{\\1c${defaultAss}\\3c&H00000000\\k${ds}\\kc${highlightAss}}`;
    }
    case 'banner': {
      // No per-word animation — the per-line block handles the box
      // styling (BackColour + BorderStyle=4).
      return wordIdx === 0 ? `{\\1c${defaultAss}}` : '';
    }
    case 'pop': {
      // Scale-up-then-down per word for a "pop in" effect.
      // Half the word duration scales 100→120%, the other half returns 120→100%.
      const half = Math.max(40, Math.round(wordDurMs / 2));
      return `{\\1c${defaultAss}\\t(0,${half},\\fscx120\\fscy120)\\t(${half},${half * 2},\\fscx100\\fscy100)}`;
    }
    case 'single_word': {
      // "Single Word" means one word visible at a time, big and centred.
      // The dialogue line for this mode is one-word-per-line (handled
      // upstream), so this per-word tag just colours.
      return `{\\1c${highlightAss}\\fscx150\\fscy150}`;
    }
    case 'typewriter': {
      // Reveal letter by letter via alpha animation. \1a controls primary
      // fill alpha (FF=transparent, 00=opaque). Fade in over the word duration.
      const dur = Math.max(80, wordDurMs);
      return `{\\1c${defaultAss}\\1a&HFF&\\t(0,${dur},\\1a&H00&)}`;
    }
    case 'motion': {
      // Subtle rotation + colour pulse per word. \frx rotates around X-axis
      // for a 3D-ish tilt; coupled with the colour swap.
      const dur = Math.max(120, wordDurMs);
      return `{\\1c${defaultAss}\\t(0,${dur},\\frx10\\1c${highlightAss})}`;
    }
    default:
      return '';
  }
}

// ─── dialogue line emission ────────────────────────────────────────────────

/**
 * Group consecutive words into "rows" of N words so subtitle lines
 * aren't too long for the screen. For the Shorts editor we group ~4
 * words per row (Word Highlight, Banner, Pop, Typewriter, Motion). The
 * Single Word animation overrides this and emits one word per row.
 */
function groupWordsIntoRows(
  words: readonly WordTiming[],
  animation: AssAnimation,
): WordTiming[][] {
  if (animation === 'single_word') return words.map((w) => [w]);
  const rows: WordTiming[][] = [];
  let cur: WordTiming[] = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= 4) {
      rows.push(cur);
      cur = [];
    }
  }
  if (cur.length > 0) rows.push(cur);
  return rows;
}

// ─── top-level ASS serializer ──────────────────────────────────────────────

export function serializeAss(opts: AssRenderOpts): string {
  const { clipWidth, clipHeight, clipStartSeconds, clipEndSeconds, style } = opts;
  const defaultAss = hexToAss(style.font_color);
  const highlightAss = hexToAss(style.highlight_color);
  const align = alignFromPos(style.x_pos, style.y_pos);
  // Absolute pixel position for \pos in each Dialogue line.
  const posX = Math.round(clipWidth * style.x_pos);
  const posY = Math.round(clipHeight * style.y_pos);

  // Slice and rebase words to clip-local time.
  const wordsInClip: WordTiming[] = [];
  for (const w of opts.words) {
    if (w.end <= clipStartSeconds) continue;
    if (w.start >= clipEndSeconds) break;
    const localStart = Math.max(0, w.start - clipStartSeconds);
    const localEnd = Math.min(clipEndSeconds - clipStartSeconds, w.end - clipStartSeconds);
    if (localEnd <= localStart) continue;
    wordsInClip.push({ word: w.word, start: localStart, end: localEnd });
  }

  // BorderStyle/Box/Shadow choice depends on animation.
  //   banner → BorderStyle 4 (opaque box behind text) + back colour
  //   others → BorderStyle 1 (outline + shadow, no box)
  const borderStyle = style.animation === 'banner' ? 4 : 1;
  const backColour = style.animation === 'banner' ? highlightAss : '&H00000000';

  const styleLine =
    `Style: Default,${style.font},${style.font_size},${defaultAss},&H000000FF,&H00000000,${backColour},` +
    `0,0,0,0,100,100,0,0,${borderStyle},2,1,${align},20,20,20,1`;

  const dialogueLines: string[] = [];
  const rows = groupWordsIntoRows(wordsInClip, style.animation);
  for (const row of rows) {
    if (row.length === 0) continue;
    // biome-ignore lint/style/noNonNullAssertion: row.length > 0 guarantees these
    const lineStart = row[0]!.start;
    // biome-ignore lint/style/noNonNullAssertion: row.length > 0 guarantees these
    const lineEnd = row[row.length - 1]!.end;
    const posTag = `{\\pos(${posX},${posY})}`;
    const parts: string[] = [posTag];
    row.forEach((w, idx) => {
      const tag = animationTagsForWord({
        wordIdx: idx,
        wordCount: row.length,
        wordDurMs: Math.round((w.end - w.start) * 1000),
        highlightAss,
        defaultAss,
        animation: style.animation,
      });
      // Escape ASS-meaningful chars in the word text.
      const text = w.word.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}');
      // Separate words with a literal space (or break for single-word mode).
      parts.push((idx > 0 ? ' ' : '') + tag + text);
    });
    dialogueLines.push(
      `Dialogue: 0,${fmtAssTime(lineStart)},${fmtAssTime(lineEnd)},Default,,0,0,0,,${parts.join('')}`,
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
