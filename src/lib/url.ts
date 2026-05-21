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
