import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { contentTypeFor, resolveMediaPath } from '@/lib/media-path';
import { verifyMediaSignature } from '@/lib/media-sign';
import { hydrateRuntimeSettingsForRoute } from '@/lib/settings';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ path: string[] }> };

function unsatisfiable(total: number): Response {
  return new Response('range not satisfiable', {
    status: 416,
    headers: { 'content-range': `bytes */${total}` },
  });
}

/**
 * Local media server for the studio's <video> element + thumbnails. Streams
 * files from under MEDIA_ROOT with a path-traversal guard and HTTP range
 * support (so the player can seek). In production the same paths are served
 * by nginx behind the Cloudflare Tunnel; this route is the dev equivalent.
 */
export async function GET(req: Request, { params }: Ctx) {
  await hydrateRuntimeSettingsForRoute('media');
  const requireSignature = process.env.MEDIA_REQUIRE_SIGNATURE === '1';

  const { path: segments } = await params;
  const rel = segments.map(decodeURIComponent).join('/');
  const abs = resolveMediaPath(rel);
  if (!abs) return new Response('forbidden', { status: 403 });

  if (requireSignature) {
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
    // #20: RFC 7233 single-range normalization — supports suffix ranges
    // (bytes=-N), open ranges (bytes=N-), and clamps the end to total-1.
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
    if (match) {
      const startRaw = match[1] ?? '';
      const endRaw = match[2] ?? '';
      let start: number;
      let end: number;
      if (startRaw === '' && endRaw === '') {
        return unsatisfiable(total);
      }
      if (startRaw === '') {
        // suffix range: last N bytes
        const suffix = Number.parseInt(endRaw, 10);
        if (suffix <= 0) return unsatisfiable(total);
        start = Math.max(total - suffix, 0);
        end = total - 1;
      } else {
        start = Number.parseInt(startRaw, 10);
        end = endRaw ? Math.min(Number.parseInt(endRaw, 10), total - 1) : total - 1;
      }
      if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
        return unsatisfiable(total);
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
