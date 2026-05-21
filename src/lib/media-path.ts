import { normalize, resolve, sep } from 'node:path';

export const MEDIA_ROOT = resolve(process.env.MEDIA_ROOT ?? '/var/channelhelm/media');

/**
 * Resolve a relative media path against MEDIA_ROOT and confirm it doesn't
 * escape. Returns the absolute path, or null if it would traverse outside.
 */
export function resolveMediaPath(relPath: string, root = MEDIA_ROOT): string | null {
  const abs = resolve(root, normalize(relPath));
  if (abs === root || abs.startsWith(root + sep)) return abs;
  return null;
}

export function isPathInsideMediaRoot(relPath: string, root = MEDIA_ROOT): boolean {
  return resolveMediaPath(relPath, root) !== null;
}

const CONTENT_TYPES: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.m4v': 'video/x-m4v',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.json': 'application/json',
  '.vtt': 'text/vtt',
};

export function contentTypeFor(absPath: string): string {
  const ext = absPath.slice(absPath.lastIndexOf('.')).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * Turn an absolute on-disk media path into a `/api/media/...` URL the
 * browser can fetch. Returns null if the path is outside MEDIA_ROOT.
 * Each path segment is URL-encoded so spaces / unicode in brand slugs or
 * filenames survive.
 */
export function mediaUrlFor(absPath: string, root = MEDIA_ROOT): string | null {
  const resolved = resolveMediaPath(absPath, root);
  if (!resolved || resolved === root) return null;
  const rel = resolved.slice(root.length + 1);
  const encoded = rel.split(sep).map(encodeURIComponent).join('/');
  return `/api/media/${encoded}`;
}
