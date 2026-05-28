/**
 * Parse a YouTube video URL into `{ url, video_id }`. Accepts the common
 * shapes the operator might paste:
 *
 *   https://www.youtube.com/watch?v=ABC123
 *   https://youtube.com/watch?v=ABC123&t=42s
 *   https://m.youtube.com/watch?v=ABC123
 *   https://youtu.be/ABC123
 *   https://www.youtube.com/shorts/ABC123
 *   https://www.youtube.com/live/ABC123
 *   https://www.youtube.com/embed/ABC123
 *
 * Returns null for anything else. The id must match YouTube's 11-char
 * alphanumeric (plus - and _) pattern.
 */
export type YoutubeRef = { url: string; videoId: string };

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function parseYoutubeUrl(input: string): YoutubeRef | null {
  const raw = input.trim();
  if (!raw) return null;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\.|^m\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = parsed.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com') {
    if (parsed.pathname === '/watch') {
      id = parsed.searchParams.get('v');
    } else {
      const parts = parsed.pathname.split('/').filter(Boolean);
      if (parts[0] === 'shorts' || parts[0] === 'live' || parts[0] === 'embed') {
        id = parts[1] ?? null;
      }
    }
  } else {
    return null;
  }
  if (!id || !VIDEO_ID.test(id)) return null;
  return { url: `https://youtu.be/${id}`, videoId: id };
}
