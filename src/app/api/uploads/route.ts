import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { withAuth } from '@/lib/http';
import { makeId } from '@/lib/ids';
import { MEDIA_ROOT } from '@/lib/media-path';
import { ProcessingProfile } from '@/lib/schemas';
import { enqueue } from '@workers/queue';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ALLOWED_EXT = new Set(['mp4', 'mov', 'webm', 'm4v', 'mkv']);

/**
 * Streamed video upload. The client sends the raw file as the request body
 * (NOT multipart) so large files never buffer in memory:
 *
 *   fetch('/api/uploads?brandId=brd_…&filename=clip.mp4&profile=standard_audio_visual',
 *         { method:'POST', body: file, headers:{authorization:`Bearer …`} })
 *
 * Creates an `uploaded_video` source with local_media_path preset, writes
 * the file to MEDIA_ROOT/{slug}/{src_id}/original.{ext}, creates the package,
 * and enqueues ingest. The ingest worker's uploaded_video branch picks it up
 * (ffmpeg only — no yt-dlp).
 */
export async function POST(req: Request) {
  return withAuth(req, async () => {
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
    try {
      await pipeline(
        Readable.fromWeb(req.body as import('node:stream/web').ReadableStream),
        createWriteStream(filePath),
      );
    } catch (err) {
      await rm(outputDir, { recursive: true, force: true });
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
  });
}
