const PALETTE = ['#0ea5e9', '#a855f7', '#10b981', '#f59e0b', '#ef4444', '#14b8a6'];

/** Deterministic accent color for a brand, derived from its slug. */
export function brandColor(slug: string): string {
  let h = 0;
  for (let i = 0; i < slug.length; i++) h = (h * 31 + slug.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length] ?? '#0ea5e9';
}
