export type ScoredItem = { text: string; score: number | null };

/**
 * Normalize a titles/tags list that may be in either the new
 * `[{text, score}]` shape or the legacy `string[]` shape (rows generated
 * before scoring landed). Legacy entries get `score: null`.
 */
export function readScoredList(value: unknown): ScoredItem[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): ScoredItem | null => {
      if (typeof item === 'string') return { text: item, score: null };
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const text = typeof o.text === 'string' ? o.text : null;
        if (text === null) return null;
        const score = typeof o.score === 'number' && Number.isFinite(o.score) ? o.score : null;
        return { text, score };
      }
      return null;
    })
    .filter((x): x is ScoredItem => x !== null);
}

/** Plain text list (drops scores) — for copy-to-clipboard of tags etc. */
export function scoredListToText(value: unknown, sep = ', '): string {
  return readScoredList(value)
    .map((i) => i.text)
    .join(sep);
}
