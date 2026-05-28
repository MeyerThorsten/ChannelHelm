import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { jobs, packages, sources } from '@/db/schema';
import { isAudioOnlyProfile } from '@/lib/schemas';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { patchPackageIntelligence } from '../integrations/db_patch';
import { sampleFrames, sampleFramesAtTimestamps } from '../integrations/ffmpeg';
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
 * Profile → OCR sample rate (fps). On-screen text rarely changes faster than
 * once every couple of seconds in standard content (talking head, tutorial,
 * podcast-with-slides), so we halve the dense sample for the default profile —
 * cuts OCR wall time in half with no observable quality loss on overlay
 * detection. Premium keeps fps=1 for high-stakes content where a flashed
 * lower-third or fast on-screen graphic might matter.
 */
const OCR_FPS_BY_PROFILE: Record<string, number> = {
  standard_audio_visual: 0.5,
  premium_multimodal: 1,
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
  if (isAudioOnlyProfile(profile)) {
    throw new Error(`analyze_visual should not run under audio-only profile '${profile}'`);
  }

  const videoPath = join(source.localMediaPath, 'original.mp4');
  const ocrFramesDir = join(source.localMediaPath, 'frames_ocr');
  const vlmFramesDir = join(source.localMediaPath, 'frames_vlm');
  const ocrPath = join(source.localMediaPath, 'ocr.json');
  const descriptionsPath = join(source.localMediaPath, 'frame_descriptions.json');
  const ocrManifestPath = join(source.localMediaPath, 'frame_manifest_ocr.json');
  const vlmManifestPath = join(source.localMediaPath, 'frame_manifest_vlm.json');
  const frameIndexPath = join(source.localMediaPath, 'frame_index.json');

  // OCR sample at profile-specific fps (standard=0.5, premium=1). Full source
  // resolution either way — Apple Vision needs the pixels to read small
  // overlay text reliably.
  const ocrFps = OCR_FPS_BY_PROFILE[profile] ?? 0.5;
  console.log(`[analyze_visual] sampling OCR frames @ fps=${ocrFps} from ${videoPath}`);
  const ocrFrames = await sampleFrames({
    inputPath: videoPath,
    outputDir: ocrFramesDir,
    fps: ocrFps,
  });
  if (ocrFrames.length === 0) {
    throw new Error('analyze_visual: ffmpeg produced no OCR frames');
  }
  await writeFile(ocrManifestPath, JSON.stringify({ frames: ocrFrames }, null, 2), 'utf8');

  // VLM sample: SPARSE, scene-cut driven, downscaled to 768px long axis.
  // Optimization (C): the ingest worker already detected scene cuts and
  // stored them on packages.intelligence.scene_cuts — describing one frame
  // per editorial beat is both ~10–15× faster than fps=1 AND produces more
  // useful descriptions for downstream chapter/clip generation. Long static
  // stretches get supplemental frames every 30 s so the VLM doesn't miss
  // mid-segment changes.
  const intelligence = (pkg.intelligence ?? {}) as Record<string, unknown>;
  const sceneCuts = Array.isArray(intelligence.scene_cuts)
    ? (intelligence.scene_cuts as number[])
    : [];
  const durationSeconds = Number(
    (intelligence.ingest as { duration_seconds?: number } | undefined)?.duration_seconds ??
      source.durationSeconds ??
      0,
  );
  const vlmTimestamps = pickVlmTimestamps(sceneCuts, durationSeconds);
  const vlmFrames = await sampleFramesAtTimestamps({
    inputPath: videoPath,
    outputDir: vlmFramesDir,
    timestamps: vlmTimestamps,
    maxDimension: 768, // (B): VLM input downscale — ~2-4× faster per frame
  });
  await writeFile(vlmManifestPath, JSON.stringify({ frames: vlmFrames }, null, 2), 'utf8');

  // (A): OCR + VLM are independent — parallelise so the slow VLM step
  // doesn't serialise behind OCR (or vice versa). Both write to distinct
  // output files so there's no contention.
  const vlmModel = VLM_BY_PROFILE[profile] ?? VLM_BY_PROFILE.standard_audio_visual;
  console.log(
    `[analyze_visual] OCR over ${ocrFrames.length} frames + mlx-vlm (${vlmModel}) over ${vlmFrames.length} keyframes (parallel)`,
  );
  const [ocrEnvelope, vlmEnvelope] = await Promise.all([
    runMlScript({
      script: 'ocr.py',
      args: { input: ocrManifestPath, output: ocrPath, level: 'accurate' },
    }),
    runMlScript({
      script: 'describe_frames.py',
      args: { input: vlmManifestPath, output: descriptionsPath, model: vlmModel },
    }),
  ]);

  const ocrRaw = JSON.parse(await readFile(ocrPath, 'utf8')) as {
    frames?: { timestamp: number; path: string; text: string; blocks: unknown[] }[];
  };
  const vlmRaw = JSON.parse(await readFile(descriptionsPath, 'utf8')) as {
    frames?: { timestamp: number; path: string; description: string }[];
    model?: string;
  };

  // Merge: OCR is dense (every second), VLM is sparse (scene keyframes).
  // For each OCR frame, propagate the most recent VLM keyframe's
  // description forward — that's "the visual context at this moment". Keeps
  // frame_index.json's shape backwards-compatible with fuse.ts's
  // composeSceneLog (which iterates dense per-second entries).
  const keyframes = (vlmRaw.frames ?? []).slice().sort((a, b) => a.timestamp - b.timestamp);
  const nearestVlmDescription = (target: number): string => {
    if (keyframes.length === 0) return '';
    // Use the latest keyframe whose timestamp ≤ target; if none, fall back
    // to the first keyframe (intro/cold-open case).
    let best = keyframes[0]?.description ?? '';
    for (const k of keyframes) {
      if (k.timestamp <= target) best = k.description ?? '';
      else break;
    }
    return best;
  };

  const merged = ocrFrames.map((f, i) => {
    const ocrEntry = ocrRaw.frames?.[i];
    return {
      timestamp: f.timestamp,
      path: f.path,
      description: nearestVlmDescription(f.timestamp),
      on_screen_text: ocrEntry?.blocks ?? [],
      on_screen_text_joined: ocrEntry?.text ?? '',
    };
  });

  const frameIndex = {
    source_id: sourceId,
    fps: ocrFps,
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

  await patchPackageIntelligence(packageId, { frame_index: frameIndex });

  // Storage lifecycle (Option A): the per-frame PNGs and the per-modality
  // intermediate JSONs are now fully consumed — the merged frame_index is
  // in Postgres and on disk as frame_index.json (the next consumer, fuse,
  // reads from Postgres but we leave the JSON for fuse to delete after
  // its own success). Reclaims ~30–55 MB per video. Set
  // KEEP_PIPELINE_ARTIFACTS=1 to keep frames around for debugging
  // (e.g. ls into frames_vlm/ to inspect what the VLM saw).
  if (process.env.KEEP_PIPELINE_ARTIFACTS !== '1') {
    await Promise.all([
      rm(ocrFramesDir, { recursive: true, force: true }),
      rm(vlmFramesDir, { recursive: true, force: true }),
      rm(ocrPath, { force: true }),
      rm(descriptionsPath, { force: true }),
      rm(ocrManifestPath, { force: true }),
      rm(vlmManifestPath, { force: true }),
    ]);
  }

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

/**
 * Choose the timestamps to send to the VLM. Anchored on scene cuts (which
 * ingest already detected and stashed on `packages.intelligence.scene_cuts`)
 * + the intro frame + the outro frame + interpolated frames inside any gap
 * longer than `maxGapSeconds` so a static-but-long segment doesn't go
 * undescribed.
 *
 * Exported for unit testing.
 *
 * Sample for an 8-min talking-head with 20 cuts → ~22 timestamps.
 * Sample for a 30-min lecture with 0 cuts     → ~31 timestamps (every 60 s).
 */
export function pickVlmTimestamps(
  sceneCuts: readonly number[],
  durationSeconds: number,
  opts: { maxGapSeconds?: number; minSpacing?: number } = {},
): number[] {
  const maxGap = opts.maxGapSeconds ?? 30;
  const minSpacing = opts.minSpacing ?? 0.5;

  // Anchors: intro, every scene cut, an outro frame ~1 s before the end.
  const anchors = new Set<number>([0]);
  for (const t of sceneCuts) {
    if (Number.isFinite(t) && t >= 0 && (durationSeconds <= 0 || t < durationSeconds)) {
      anchors.add(t);
    }
  }
  if (durationSeconds > 1) anchors.add(Math.max(0, durationSeconds - 1));
  const sorted = Array.from(anchors).sort((a, b) => a - b);

  // Fill gaps longer than maxGap with interior frames.
  const filled: number[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const t = sorted[i];
    if (t === undefined) continue;
    filled.push(t);
    const next = sorted[i + 1];
    if (next === undefined) continue;
    let mid = t + maxGap;
    while (next - mid > minSpacing) {
      filled.push(mid);
      mid += maxGap;
    }
  }

  // Dedupe near-duplicates (timestamps within minSpacing collapse to one).
  const out: number[] = [];
  for (const t of filled) {
    const last = out[out.length - 1];
    if (last === undefined || t - last >= minSpacing) out.push(t);
  }
  return out;
}
