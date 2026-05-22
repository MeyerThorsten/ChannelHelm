import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { contentTypeFor, resolveMediaPath } from '@/lib/media-path';
import { verifyMediaSignature } from '@/lib/media-sign';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// §9.4: when serving media on a publicly reachable host, require signed URLs.
// Set MEDIA_REQUIRE_SIGNATURE=1 in that deployment; local dev leaves it unset
// so the studio's <video> can stream directly.
const REQUIRE_SIGNATURE = process.env.MEDIA_REQUIRE_SIGNATURE === '1';

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * Local media server for the studio's <video> element + thumbnails. Streams
 * files from under MEDIA_ROOT with a path-traversal guard and HTTP range
 * support (so the player can seek). In production the same paths are served
 * by nginx behind the Cloudflare Tunnel; this route is the dev equivalent.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { path: segments } = await params;
  const rel = segments.map(decodeURIComponent).join('/');
  const abs = resolveMediaPath(rel);
  if (!abs) return new Response('forbidden', { status: 403 });

  if (REQUIRE_SIGNATURE) {
    const url = new URL(req.url);
    const exp = Number.parseInt(url.searchParams.get('exp') ?? '', 10);
    const sig = url.searchParams.get('sig');
    if (!verifyMediaSignature(rel, exp, sig)) {
      return new Response('forbidden', { status: 403 });
    }
  }

  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(abs);
  } catch {
    return new Response('not found', { status: 404 });
  }
  if (!fileStat.isFile()) return new Response('not found', { status: 404 });

  const contentType = contentTypeFor(abs);
  const total = fileStat.size;
  const range = req.headers.get('range');

  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      const start = match[1] ? Number.parseInt(match[1], 10) : 0;
      const end = match[2] ? Number.parseInt(match[2], 10) : total - 1;
      if (start > end || start >= total) {
        return new Response('range not satisfiable', {
          status: 416,
          headers: { 'content-range': `bytes */${total}` },
        });
      }
      const stream = createReadStream(abs, { start, end });
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 206,
        headers: {
          'content-type': contentType,
          'content-length': String(end - start + 1),
          'content-range': `bytes ${start}-${end}/${total}`,
          'accept-ranges': 'bytes',
          'cache-control': 'private, max-age=3600',
        },
      });
    }
  }

  const stream = createReadStream(abs);
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    status: 200,
    headers: {
      'content-type': contentType,
      'content-length': String(total),
      'accept-ranges': 'bytes',
      'cache-control': 'private, max-age=3600',
    },
  });
}
