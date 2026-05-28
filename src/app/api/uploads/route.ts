import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { makeId } from '@/lib/ids';
import { MEDIA_ROOT } from '@/lib/media-path';
import { ProcessingProfile } from '@/lib/schemas';
import { hydrateRuntimeSettingsForRoute } from '@/lib/settings';
import { enqueue } from '@workers/queue';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'mkv']);

function maxUploadBytes(): number {
  const n = Number(process.env.MAX_UPLOAD_BYTES ?? 2_000_000_000);
  return Number.isFinite(n) && n > 0 ? n : 2_000_000_000;
}

/**
 * #15 CSRF guard for the cookieless dashboard upload. A cross-origin page that
 * tries to POST here sends a mismatched Origin and is rejected; the same-origin
 * dashboard fetch passes. A valid bearer token (curl/scripts) also passes.
 */
function authorizedUpload(req: Request): boolean {
  const token = process.env.LOCAL_BEARER_TOKEN;
  const auth = req.headers.get('authorization');
  if (token && auth === `Bearer ${token}`) return true;
  const origin = req.headers.get('origin');
  if (!origin) return true; // non-browser caller without Origin (e.g. curl)
  try {
    return new URL(origin).host === new URL(req.url).host;
  } catch {
    return false;
  }
}

/**
 * Streamed video upload from the dashboard. The browser sends the raw file
 * as the request body (NOT multipart) so large files never buffer in memory:
 *
 *   fetch('/api/uploads?brandId=brd_…&filename=clip.mp4&profile=standard_audio_visual',
 *         { method:'POST', body: file })
 *
 * Creates an `uploaded_video` source with local_media_path preset, writes
 * the file to MEDIA_ROOT/{slug}/{src_id}/original.{ext}, creates the package,
 * and enqueues ingest. The ingest worker's uploaded_video branch picks it up
 * (ffmpeg only — no yt-dlp).
 *
 * Authorization (#15): a same-origin guard (or a valid bearer token) — a
 * cross-origin page can't drive uploads. Size is capped (MAX_UPLOAD_BYTES)
 * from Content-Length and while streaming, with partial-file cleanup on
 * overflow.
 */
export async function POST(req: Request) {
  {
    await hydrateRuntimeSettingsForRoute('uploads');
    const maxBytes = maxUploadBytes();

    if (!authorizedUpload(req)) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    const declared = Number(req.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      return Response.json({ error: 'payload_too_large', maxBytes }, { status: 413 });
    }

    const url = new URL(req.url);
    const brandId = url.searchParams.get('brandId') ?? '';
    const filename = url.searchParams.get('filename') ?? 'upload.mp4';
    const profileRaw = url.searchParams.get('profile') ?? 'standard_audio_visual';

    if (!brandId.startsWith('brd_')) {
      return Response.json({ error: 'brandId query param required' }, { status: 400 });
    }
    const profile = ProcessingProfile.safeParse(profileRaw);
    if (!profile.success) {
      return Response.json({ error: 'invalid profile' }, { status: 400 });
    }
    const ext = (filename.split('.').pop() ?? '').toLowerCase();
    if (!ALLOWED_EXT.has(ext)) {
      return Response.json(
        { error: 'unsupported_file_type', allowed: [...ALLOWED_EXT] },
        { status: 415 },
      );
    }
    if (!req.body) {
      return Response.json({ error: 'empty_body' }, { status: 400 });
    }

    const [brand] = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);
    if (!brand) return Response.json({ error: 'brand_not_found' }, { status: 404 });

    const sourceId = makeId('src');
    const outputDir = join(MEDIA_ROOT, brand.slug, sourceId);
    const filePath = join(outputDir, `original.${ext}`);

    await mkdir(outputDir, { recursive: true });
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _enc, cb) {
        received += chunk.length;
        if (received > maxBytes) {
          cb(new Error('upload_too_large'));
          return;
        }
        cb(null, chunk);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(req.body as import('node:stream/web').ReadableStream),
        limiter,
        createWriteStream(filePath),
      );
    } catch (err) {
      await rm(outputDir, { recursive: true, force: true });
      if (err instanceof Error && err.message === 'upload_too_large') {
        return Response.json({ error: 'payload_too_large', maxBytes }, { status: 413 });
      }
      console.error('[upload] stream failed', err);
      return Response.json({ error: 'upload_failed' }, { status: 500 });
    }

    const [source] = await db
      .insert(sources)
      .values({
        id: sourceId,
        brandId,
        kind: 'uploaded_video',
        localMediaPath: outputDir,
        title: filename.replace(/\.[^.]+$/, ''),
      })
      .returning();
    if (!source) {
      await rm(outputDir, { recursive: true, force: true });
      return Response.json({ error: 'source_insert_failed' }, { status: 500 });
    }

    const [pkg] = await db
      .insert(packages)
      .values({ brandId, sourceId, processingProfile: profile.data })
      .returning();
    if (!pkg) return Response.json({ error: 'package_insert_failed' }, { status: 500 });

    const job = await enqueue({
      kind: 'ingest',
      payload: { sourceId, packageId: pkg.id },
      idempotencyKey: `ingest:${sourceId}`,
    });

    return Response.json({ package: pkg, source, ingestJob: job, filePath }, { status: 201 });
  }
}
