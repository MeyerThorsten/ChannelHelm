import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { detectScenes, extractAudioWav } from '../integrations/ffmpeg';
import { downloadVideo } from '../integrations/ytdlp';
import { type JobRow, enqueue } from '../queue';

const IngestPayload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
});

/**
 * §13 step 4. Downloads a source's media (yt-dlp), extracts audio (ffmpeg),
 * detects scene cuts (ffmpeg), writes `local_media_path` + `duration_seconds`
 * back to the source, seeds `packages.intelligence.scene_cuts`, and fans out
 * to the downstream `transcribe_audio` (and `analyze_visual`, conditional on
 * the processing profile) jobs.
 *
 * Currently supports `kind='youtube_url'` only — uploaded_video and podcast
 * will be added when those source-creation flows are wired up.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId } = IngestPayload.parse(job.payload);

  const source = await loadSource(sourceId);
  const pkg = await loadPackage(packageId);
  const brand = await loadBrand(source.brandId);
  const profile = pkg.processingProfile;

  if (source.kind !== 'youtube_url') {
    throw new Error(
      `ingest: source ${sourceId} has unsupported kind '${source.kind}' (v1 supports youtube_url)`,
    );
  }
  if (!source.originUrl) {
    throw new Error(`ingest: source ${sourceId} has no origin_url`);
  }

  const mediaRoot = process.env.MEDIA_ROOT ?? '/var/channelhelm/media';
  const outputDir = join(mediaRoot, brand.slug, sourceId);

  console.log(`[ingest] downloading ${source.originUrl} → ${outputDir}`);
  const dl = await downloadVideo({ url: source.originUrl, outputDir });

  const audioPath = join(outputDir, 'audio.wav');
  console.log(`[ingest] extracting audio → ${audioPath}`);
  await extractAudioWav({ inputPath: dl.filePath, outputPath: audioPath });

  let sceneCuts: number[] = [];
  if (profile === 'fast_audio_only') {
    console.log('[ingest] profile=fast_audio_only — skipping scene detection');
  } else {
    console.log('[ingest] detecting scene cuts');
    sceneCuts = await detectScenes({ inputPath: dl.filePath });
    console.log(`[ingest] found ${sceneCuts.length} cuts`);
  }

  await db
    .update(sources)
    .set({
      localMediaPath: outputDir,
      durationSeconds: dl.durationSeconds || null,
      title: source.title ?? dl.title ?? null,
    })
    .where(eq(sources.id, sourceId));

  const intelligence = {
    ...(pkg.intelligence as Record<string, unknown>),
    scene_cuts: sceneCuts,
    ingest: {
      yt_dlp_title: dl.title,
      duration_seconds: dl.durationSeconds,
      file_path: dl.filePath,
      audio_path: audioPath,
      host: hostname(),
      profile,
    },
  };
  await db.update(packages).set({ intelligence }).where(eq(packages.id, packageId));

  await enqueue({
    kind: 'transcribe_audio',
    payload: { sourceId, packageId, processingProfile: profile },
    idempotencyKey: `transcribe_audio:${sourceId}`,
  });
  if (profile !== 'fast_audio_only') {
    await enqueue({
      kind: 'analyze_visual',
      payload: { sourceId, packageId, processingProfile: profile },
      idempotencyKey: `analyze_visual:${sourceId}:${profile}`,
    });
  }
}

async function loadSource(id: string) {
  const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
  if (!row) throw new Error(`ingest: source ${id} not found`);
  return row;
}

async function loadPackage(id: string) {
  const [row] = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
  if (!row) throw new Error(`ingest: package ${id} not found`);
  return row;
}

async function loadBrand(id: string) {
  const [row] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  if (!row) throw new Error(`ingest: brand ${id} not found`);
  return row;
}
