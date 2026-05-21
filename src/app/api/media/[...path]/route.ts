import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { contentTypeFor, resolveMediaPath } from '@/lib/media-path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

/**
 * Local media server for the studio's <video> element + thumbnails. Streams
 * files from under MEDIA_ROOT with a path-traversal guard and HTTP range
 * support (so the player can seek). In production the same paths are served
 * by nginx behind the Cloudflare Tunnel; this route is the dev equivalent.
 */
export async function GET(req: Request, { params }: Ctx) {
  const { path: segments } = await params;
  const abs = resolveMediaPath(segments.join('/'));
  if (!abs) return new Response('forbidden', { status: 403 });

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
