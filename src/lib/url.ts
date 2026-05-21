/**
 * Normalize a URL/host to a comparable registrable-ish domain: lowercased,
 * protocol + path + leading `www.` stripped. Good enough to match
 * "https://www.ThorstenMeyerAI.com/about" against "thorstenmeyerai.com".
 * Returns null when there's no usable host.
 */
export function registrableDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let s = input.trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const host = new URL(s).hostname.toLowerCase();
    return host.replace(/^www\./, '') || null;
  } catch {
    return null;
  }
}

export function sameDomain(a: string | null | undefined, b: string | null | undefined): boolean {
  const da = registrableDomain(a);
  const db = registrableDomain(b);
  return da !== null && da === db;
}

/** A slug from a channel/brand name: lowercase, alnum + dashes, trimmed. */
export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'brand'
  );
}

/** True when `s` is already a canonical YouTube channel id (UC…). */
export function looksLikeChannelId(s: string | null | undefined): boolean {
  return !!s && /^UC[A-Za-z0-9_-]{20,}$/.test(s.trim());
}

/**
 * Normalize whatever the operator typed into a YouTube channel URL that
 * yt-dlp can resolve. Accepts a UC… id, an @handle, a bare handle, or a
 * full youtube.com URL. Returns null when there's nothing usable.
 */
export function channelUrlFrom(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;
  if (looksLikeChannelId(s)) return `https://www.youtube.com/channel/${s}`;
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('@')) return `https://www.youtube.com/${s}`;
  return `https://www.youtube.com/@${s}`;
}
