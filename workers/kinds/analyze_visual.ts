import { readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { jobs, packages, sources } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { sampleFrames } from '../integrations/ffmpeg';
import { runMlScript } from '../integrations/ml_subprocess';
import { type JobRow, enqueue } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

// Profile → VLM model. Premium uses the larger weights per §5.5.
const VLM_BY_PROFILE: Record<string, string> = {
  standard_audio_visual: 'mlx-community/Qwen2.5-VL-7B-Instruct-4bit',
  premium_multimodal: 'mlx-community/Qwen2.5-VL-32B-Instruct-4bit',
};

/**
 * §13 step 6. Samples frames at 1 fps with ffmpeg, runs Apple Vision OCR via
 * `ml/ocr.py`, runs mlx-vlm via `ml/describe_frames.py`, merges into a single
 * frame index at `packages.intelligence.frame_index`, attaches §2.2
 * provenance for both, and (per §6.2) enqueues `fuse` if the sibling
 * transcribe_audio job is done.
 *
 * Skipped at enqueue time for `fast_audio_only` profile (§5.5) — this
 * handler should never be invoked under that profile.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, processingProfile } = Payload.parse(job.payload);

  const [source] = await db.select().from(sources).where(eq(sources.id, sourceId)).limit(1);
  if (!source) throw new Error(`analyze_visual: source ${sourceId} not found`);
  if (!source.localMediaPath) {
    throw new Error(
      `analyze_visual: source ${sourceId} has no local_media_path (ingest must run first)`,
    );
  }

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`analyze_visual: package ${packageId} not found`);
  const profile = processingProfile ?? pkg.processingProfile;
  if (profile === 'fast_audio_only') {
    throw new Error('analyze_visual should not run under fast_audio_only profile');
  }

  const videoPath = join(source.localMediaPath, 'original.mp4');
  const framesDir = join(source.localMediaPath, 'frames');
  const ocrPath = join(source.localMediaPath, 'ocr.json');
  const descriptionsPath = join(source.localMediaPath, 'frame_descriptions.json');
  const manifestPath = join(source.localMediaPath, 'frame_manifest.json');
  const frameIndexPath = join(source.localMediaPath, 'frame_index.json');

  console.log(`[analyze_visual] sampling frames from ${videoPath}`);
  const frames = await sampleFrames({ inputPath: videoPath, outputDir: framesDir, fps: 1 });
  if (frames.length === 0) {
    throw new Error('analyze_visual: ffmpeg produced no frames');
  }

  // The Python CLIs read a JSON manifest of frame paths + timestamps. Same
  // shape feeds both OCR and the VLM so they line up by index later.
  await writeFile(manifestPath, JSON.stringify({ frames }, null, 2), 'utf8');

  console.log(`[analyze_visual] OCR over ${frames.length} frames`);
  const ocrEnvelope = await runMlScript({
    script: 'ocr.py',
    args: { input: manifestPath, output: ocrPath, level: 'accurate' },
  });

  const vlmModel = VLM_BY_PROFILE[profile] ?? VLM_BY_PROFILE.standard_audio_visual;
  console.log(`[analyze_visual] mlx-vlm (${vlmModel}) over ${frames.length} frames`);
  const vlmEnvelope = await runMlScript({
    script: 'describe_frames.py',
    args: { input: manifestPath, output: descriptionsPath, model: vlmModel },
  });

  const ocrRaw = JSON.parse(await readFile(ocrPath, 'utf8')) as {
    frames?: { timestamp: number; path: string; text: string; blocks: unknown[] }[];
  };
  const vlmRaw = JSON.parse(await readFile(descriptionsPath, 'utf8')) as {
    frames?: { timestamp: number; path: string; description: string }[];
    model?: string;
  };

  // Merge OCR + VLM by frame index (same manifest, same order).
  const merged = frames.map((f, i) => {
    const ocrEntry = ocrRaw.frames?.[i];
    const vlmEntry = vlmRaw.frames?.[i];
    return {
      timestamp: f.timestamp,
      path: f.path,
      description: vlmEntry?.description ?? '',
      on_screen_text: ocrEntry?.blocks ?? [],
      on_screen_text_joined: ocrEntry?.text ?? '',
    };
  });

  const frameIndex = {
    source_id: sourceId,
    fps: 1,
    frame_count: merged.length,
    frames: merged,
    provenance: {
      ocr: {
        provider: 'apple-vision',
        model: String(ocrEnvelope.model ?? 'vision-3.0'),
        host: String(ocrEnvelope.host ?? hostname()),
        prompt_version: null,
        input_refs: [`frames:${sourceId}`],
        generated_at: new Date().toISOString(),
        profile,
        duration_ms: ocrEnvelope.duration_ms,
      },
      vlm: {
        provider: 'mlx-vlm',
        model: String(vlmEnvelope.model ?? vlmModel),
        host: String(vlmEnvelope.host ?? hostname()),
        prompt_version: 'describe_frames.v1',
        input_refs: [`frames:${sourceId}`],
        generated_at: new Date().toISOString(),
        profile,
        duration_ms: vlmEnvelope.duration_ms,
      },
    },
  };
  await writeFile(frameIndexPath, JSON.stringify(frameIndex, null, 2), 'utf8');

  const intelligence = {
    ...(pkg.intelligence as Record<string, unknown>),
    frame_index: frameIndex,
  };
  await db.update(packages).set({ intelligence }).where(eq(packages.id, packageId));

  await maybeEnqueueFuse({ sourceId, packageId, profile });
}

async function maybeEnqueueFuse(opts: {
  sourceId: string;
  packageId: string;
  profile: string;
}): Promise<void> {
  const { sourceId, packageId, profile } = opts;
  const siblings = await db
    .select({ status: jobs.status })
    .from(jobs)
    .where(and(eq(jobs.kind, 'transcribe_audio'), sql`${jobs.payload}->>'sourceId' = ${sourceId}`))
    .limit(1);
  const sibling = siblings[0];
  if (!sibling || sibling.status === 'done') {
    await enqueue({
      kind: 'fuse',
      payload: { sourceId, packageId, processingProfile: profile },
      idempotencyKey: `fuse:${sourceId}:${profile}`,
    });
  } else {
    console.log(
      `[analyze_visual] transcribe_audio sibling status=${sibling.status}, deferring fuse enqueue`,
    );
  }
}
