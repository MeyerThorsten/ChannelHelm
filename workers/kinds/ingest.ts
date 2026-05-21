import { readdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { detectScenes, extractAudioWav, probeDurationSeconds } from '../integrations/ffmpeg';
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
 * Supports `kind='youtube_url'` (yt-dlp download) and `kind='uploaded_video'`
 * (the file is already on disk at local_media_path/original.<ext>, so we skip
 * yt-dlp and probe duration with ffprobe).
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId } = IngestPayload.parse(job.payload);

  const source = await loadSource(sourceId);
  const pkg = await loadPackage(packageId);
  const brand = await loadBrand(source.brandId);
  const profile = pkg.processingProfile;

  // Acquire the local video file + metadata depending on source kind.
  let outputDir: string;
  let videoPath: string;
  let durationSeconds: number;
  let title: string | null;

  if (source.kind === 'youtube_url') {
    if (!source.originUrl) throw new Error(`ingest: source ${sourceId} has no origin_url`);
    const mediaRoot = process.env.MEDIA_ROOT ?? '/var/channelhelm/media';
    // Always store an absolute path — downstream workers spawn subprocesses
    // with cwd=ml/, so a relative local_media_path would resolve incorrectly.
    outputDir = resolve(mediaRoot, brand.slug, sourceId);
    console.log(`[ingest] downloading ${source.originUrl} → ${outputDir}`);
    const dl = await downloadVideo({ url: source.originUrl, outputDir });
    videoPath = dl.filePath;
    durationSeconds = dl.durationSeconds;
    title = source.title ?? dl.title ?? null;
  } else if (source.kind === 'uploaded_video') {
    if (!source.localMediaPath) {
      throw new Error(`ingest: uploaded_video ${sourceId} has no local_media_path`);
    }
    outputDir = resolve(source.localMediaPath);
    videoPath = await findUploadedVideo(outputDir);
    console.log(`[ingest] uploaded file ${videoPath}`);
    durationSeconds = Math.round(await probeDurationSeconds(videoPath));
    title = source.title ?? null;
  } else {
    throw new Error(
      `ingest: source ${sourceId} has unsupported kind '${source.kind}' (youtube_url | uploaded_video)`,
    );
  }

  const audioPath = join(outputDir, 'audio.wav');
  console.log(`[ingest] extracting audio → ${audioPath}`);
  await extractAudioWav({ inputPath: videoPath, outputPath: audioPath });

  let sceneCuts: number[] = [];
  if (profile === 'fast_audio_only') {
    console.log('[ingest] profile=fast_audio_only — skipping scene detection');
  } else {
    console.log('[ingest] detecting scene cuts');
    sceneCuts = await detectScenes({ inputPath: videoPath });
    console.log(`[ingest] found ${sceneCuts.length} cuts`);
  }

  await db
    .update(sources)
    .set({
      localMediaPath: outputDir,
      durationSeconds: durationSeconds || null,
      title,
    })
    .where(eq(sources.id, sourceId));

  const intelligence = {
    ...(pkg.intelligence as Record<string, unknown>),
    scene_cuts: sceneCuts,
    ingest: {
      title,
      duration_seconds: durationSeconds,
      file_path: videoPath,
      audio_path: audioPath,
      host: hostname(),
      profile,
      kind: source.kind,
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

/**
 * The upload route writes the file as `original.<ext>`. Find it (any video
 * extension) within the source's media dir.
 */
async function findUploadedVideo(dir: string): Promise<string> {
  const entries = await readdir(dir);
  const original = entries.find((f) => /^original\.(mp4|mov|webm|m4v|mkv)$/i.test(f));
  if (!original) {
    throw new Error(`ingest: no original.<ext> video found in ${dir}`);
  }
  return join(dir, original);
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
