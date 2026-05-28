/**
 * Sentiment-over-time curve (v1.5) — a lexicon-based emotion read over the
 * fused scene log. No new model inference: it scores each window's spoken text
 * for valence (positive ↔ negative) and arousal (calm ↔ intense), so the clip
 * planner can prefer high-energy moments and the Studio can show an emotion
 * sparkline. Pure + deterministic → unit-tested (mirrors word-snap / ab-decision).
 */

export type SentimentWindow = { start: number; end: number; text: string };

export type SentimentPoint = {
  index: number;
  start: number;
  end: number;
  valence: number; // -1 (negative) … 1 (positive)
  arousal: number; // 0 (calm) … 1 (intense)
  score: number; // 0 … 1 emotional intensity, for ranking clip moments
};

export type SentimentCurve = {
  points: SentimentPoint[];
  peak_window_indices: number[]; // highest-intensity windows, best-first
};

// Compact, deterministic lexicons. Not exhaustive — enough to track the shape
// of the curve. Lowercased, matched on word boundaries.
const POSITIVE = new Set([
  'love',
  'great',
  'amazing',
  'awesome',
  'best',
  'incredible',
  'perfect',
  'win',
  'wins',
  'winning',
  'happy',
  'excited',
  'exciting',
  'beautiful',
  'brilliant',
  'fantastic',
  'wonderful',
  'success',
  'successful',
  'good',
  'better',
  'huge',
  'breakthrough',
  'powerful',
  'easy',
  'free',
  'proud',
  'gain',
  'gains',
  'boost',
  'improve',
  'improved',
  'favorite',
  'favourite',
  'enjoy',
  'fun',
  'smart',
  'clever',
  'strong',
  'works',
  'worked',
]);
const NEGATIVE = new Set([
  'hate',
  'terrible',
  'awful',
  'worst',
  'bad',
  'horrible',
  'fail',
  'failed',
  'failure',
  'wrong',
  'broken',
  'problem',
  'problems',
  'hard',
  'difficult',
  'scary',
  'scared',
  'fear',
  'angry',
  'sad',
  'disappointed',
  'disappointing',
  'annoying',
  'painful',
  'pain',
  'crash',
  'crashed',
  'bug',
  'bugs',
  'expensive',
  'slow',
  'risk',
  'risky',
  'danger',
  'dangerous',
  'lose',
  'losing',
  'lost',
  'struggle',
  'struggling',
  'mistake',
]);
// Words that signal intensity regardless of polarity.
const HIGH_AROUSAL = new Set([
  'shocking',
  'shocked',
  'insane',
  'crazy',
  'unbelievable',
  'never',
  'always',
  'everyone',
  'nobody',
  'must',
  'need',
  'now',
  'instantly',
  'explosive',
  'massive',
  'urgent',
  'warning',
  'secret',
  'revealed',
  'finally',
  'suddenly',
  'wow',
  'omg',
  'what',
  'why',
  'how',
  'stop',
  'watch',
  'listen',
  'wait',
  'huge',
  'incredible',
  'amazing',
  'terrible',
  'worst',
  'best',
  'breakthrough',
  'game-changer',
  'mind-blowing',
]);

function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Score a single window's text into valence/arousal/intensity. */
export function scoreText(text: string): { valence: number; arousal: number; score: number } {
  const tokens = tokenize(text);
  if (tokens.length === 0) return { valence: 0, arousal: 0, score: 0 };

  let pos = 0;
  let neg = 0;
  let arousalHits = 0;
  for (const t of tokens) {
    if (POSITIVE.has(t)) pos++;
    if (NEGATIVE.has(t)) neg++;
    if (HIGH_AROUSAL.has(t)) arousalHits++;
  }

  const exclamations = (text.match(/!/g) ?? []).length;
  const questions = (text.match(/\?/g) ?? []).length;
  // ALL-CAPS words (length ≥ 2) read as emphasis/shouting.
  const caps = (text.match(/\b[A-Z]{2,}\b/g) ?? []).length;

  const valence = pos + neg === 0 ? 0 : clamp((pos - neg) / (pos + neg), -1, 1);

  // Arousal: density of intense words + punctuation/caps emphasis, per ~12 words.
  const per = Math.max(1, tokens.length / 12);
  const arousalRaw = (arousalHits + exclamations + 0.5 * questions + caps) / per;
  const arousal = clamp(arousalRaw, 0, 1);

  // Emotional intensity for ranking: arousal weighted up by strong valence.
  const score = clamp(arousal * (0.6 + 0.4 * Math.abs(valence)), 0, 1);
  return { valence, arousal, score };
}

/**
 * Build the emotion curve across scene-log windows. `peakCount` (default: top
 * ~20%, min 1, max 10) flags the highest-intensity windows for clip selection.
 */
export function computeSentimentCurve(
  windows: SentimentWindow[],
  peakCount?: number,
): SentimentCurve {
  const points: SentimentPoint[] = windows.map((w, i) => {
    const s = scoreText(w.text ?? '');
    return { index: i, start: w.start, end: w.end, ...s };
  });

  const n = points.length;
  const topN = peakCount ?? clamp(Math.round(n * 0.2), 1, 10);
  const peak_window_indices = [...points]
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, Math.min(topN, n))
    .filter((p) => p.score > 0)
    .map((p) => p.index);

  return { points, peak_window_indices };
}
