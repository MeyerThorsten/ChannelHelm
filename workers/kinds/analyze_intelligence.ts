import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { db } from '@/db/client';
import { brands, packages, signals, sources } from '@/db/schema';
import {
  type CalibrationSample,
  applyCalibration,
  fitCalibration,
  predictedRetentionFraction,
} from '@/lib/retention-calibration';
import { isAudioOnlyProfile } from '@/lib/schemas';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { patchPackageIntelligence } from '../integrations/db_patch';
import { complete } from '../integrations/lm_studio';
import { loadPrompt, render } from '../integrations/prompts';
import { type JobRow, enqueue } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

const ASSET_TYPES = [
  'youtube_title_set',
  'youtube_description',
  'youtube_chapters',
  'youtube_tags',
  'linkedin_post',
  'x_post',
  'x_thread',
  'article_brief',
  'newsletter_summary',
  // Pinned comment to seed discussion + a CTA. Dispatches via the manual
  // route (operator pastes + pins); the YouTube API doesn't expose pinning.
  'youtube_pinned_comment',
  // §13 step 14: clip_render consumes this. Plans live under
  // routing.internal and never dispatch — operator approves a plan to
  // trigger one clip_render job per entry.
  'short_clip_plan',
] as const;

/**
 * §13 step 8. Reads packages.intelligence.scene_log, calls Qwen3 via LM
 * Studio with the `analyze_intelligence.v1` prompt, parses the JSON output,
 * writes it into packages.intelligence.analysis with §2.2 provenance, then
 * fans out one `generate_asset` job per asset type listed in §9 of the
 * build sequence.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, processingProfile } = Payload.parse(job.payload);
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`analyze_intelligence: package ${packageId} not found`);
  const profile = processingProfile ?? pkg.processingProfile;

  await produceAnalysis(packageId);

  // Storage lifecycle (Option A): scene_log.json is fully consumed —
  // the LLM has finished reading it and the canonical copy is in
  // packages.intelligence.scene_log. The on-demand section-regen path
  // calls produceAnalysis() alone (no rm), so deletion lives here in
  // run() not in produceAnalysis(). Set KEEP_PIPELINE_ARTIFACTS=1 to
  // retain the file for debugging.
  if (process.env.KEEP_PIPELINE_ARTIFACTS !== '1') {
    const [src] = await db
      .select({ localMediaPath: sources.localMediaPath })
      .from(sources)
      .where(eq(sources.id, sourceId))
      .limit(1);
    if (src?.localMediaPath) {
      await rm(join(src.localMediaPath, 'scene_log.json'), { force: true });
    }
  }

  // Fan out generate_asset for every type from §13 step 9 (now includes
  // short_clip_plan). Plans remain non-dispatchable; approving a plan
  // enqueues clip_render per entry via the approveAsset server action.
  for (const assetType of ASSET_TYPES) {
    await enqueue({
      kind: 'generate_asset',
      payload: { sourceId, packageId, assetType, processingProfile: profile },
      idempotencyKey: `generate_asset:${packageId}:${assetType}`,
    });
  }

  // §13 step 15 — thumbnail concepts are not LLM-generated assets; they're
  // produced by extracting frames at the hook timestamps the LLM just gave
  // us. fast_audio_only profile has no frame_index to draw from (§5.5), so
  // skip it there. Idempotency key matches the §4 convention.
  if (!isAudioOnlyProfile(profile)) {
    await enqueue({
      kind: 'thumbnail_concepts',
      payload: { sourceId, packageId, processingProfile: profile },
      idempotencyKey: `thumbnail_concepts:${packageId}`,
    });
  }
}

/**
 * Run the analyze_intelligence LLM over the package's scene_log and write
 * the result to intelligence.analysis (status → analyzed). NO fan-out — the
 * worker's run() does that; the on-demand section path calls this alone.
 * Idempotent-ish: overwrites the analysis each call.
 */
export async function produceAnalysis(packageId: string): Promise<void> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`produceAnalysis: package ${packageId} not found`);
  const intelligence = pkg.intelligence as Record<string, unknown>;
  const sceneLog = intelligence.scene_log;
  if (!sceneLog) throw new Error('produceAnalysis: scene_log missing — fuse must run first');
  const [brand] = await db.select().from(brands).where(eq(brands.id, pkg.brandId)).limit(1);
  if (!brand) throw new Error(`produceAnalysis: brand ${pkg.brandId} not found`);

  const prompt = await loadPrompt('analyze_intelligence', 1);
  const user = render(prompt, { brand, scene_log: compactSceneLog(sceneLog) });
  const windows = Array.isArray((sceneLog as { windows?: unknown[] }).windows)
    ? (sceneLog as { windows: unknown[] }).windows.length
    : 0;
  console.log(`[analyze_intelligence] calling LLM (windows=${windows})`);
  const result = await complete({
    profile: pkg.processingProfile,
    system: prompt.system ?? undefined,
    user,
    promptVersion: `${prompt.name}.v${prompt.version}`,
    inputRefs: [`scene_log:${pkg.sourceId}`],
    maxTokens: 2048,
    temperature: 0.4,
  });

  const parsed = parseJsonStrict(result.text, 'analyze_intelligence');
  const parsedObj =
    parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { raw: parsed };

  // F3: calibrate the LLM's retention guess against this brand's measured
  // history. predicted_fraction = share of windows flagged high-retention;
  // collect_signal accumulates the real average view fraction per published
  // video. Below the sample threshold the calibration is identity (no-op).
  const windowCount = Array.isArray((sceneLog as { windows?: unknown[] }).windows)
    ? (sceneLog as { windows: unknown[] }).windows.length
    : 0;
  const retention =
    parsedObj.retention && typeof parsedObj.retention === 'object'
      ? (parsedObj.retention as Record<string, unknown>)
      : {};
  const hrwCount = Array.isArray(retention.high_retention_windows)
    ? (retention.high_retention_windows as unknown[]).length
    : 0;
  const predictedFraction = predictedRetentionFraction(hrwCount, windowCount);
  if (predictedFraction != null) {
    const model = fitCalibration(await loadRetentionSamples(pkg.brandId));
    parsedObj.retention = {
      ...retention,
      predicted_fraction: predictedFraction,
      calibrated_estimate: applyCalibration(predictedFraction, model),
      calibration: { a: model.a, b: model.b, n: model.n, fitted: model.fitted },
    };
  }

  await patchPackageIntelligence(
    packageId,
    { analysis: { ...parsedObj, provenance: result.provenance } },
    { status: 'analyzed' },
  );
}

/**
 * Load this brand's (predicted, actual) retention pairs from the signals table.
 * collect_signal writes a `retention_sample` row per published video with the
 * measured average view fraction as the value and the predicted fraction in
 * metadata. These train the per-brand calibration.
 */
async function loadRetentionSamples(brandId: string): Promise<CalibrationSample[]> {
  const rows = await db
    .select({ value: signals.value, metadata: signals.metadata })
    .from(signals)
    .where(and(eq(signals.brandId, brandId), eq(signals.metric, 'retention_sample')));
  const samples: CalibrationSample[] = [];
  for (const r of rows) {
    const predicted = (r.metadata as { predicted?: unknown } | null)?.predicted;
    if (typeof predicted === 'number' && Number.isFinite(r.value)) {
      samples.push({ predicted, actual: r.value });
    }
  }
  return samples;
}

/**
 * Compact a full §5.2 scene_log into something that fits a modest LLM
 * context: per-window index + timing + (truncated) text + a one-line visual
 * hint, dropping the verbose audio_features / OCR blocks / per-frame
 * descriptions. The transcript text + timing is the signal the analysis
 * actually reasons over; the rest blows the context on longer videos.
 */
function compactSceneLog(sceneLog: unknown): unknown {
  const log = sceneLog as {
    windows?: {
      start: number;
      end: number;
      text?: string;
      visual_descriptions?: { description?: string }[];
    }[];
    global_features?: unknown;
  };
  const windows = (log.windows ?? []).map((w, i) => {
    const text = w.text ?? '';
    const visual = w.visual_descriptions?.[0]?.description;
    return {
      i,
      start: w.start,
      end: w.end,
      text: text.length > 280 ? `${text.slice(0, 280)}…` : text,
      ...(visual ? { visual: visual.slice(0, 120) } : {}),
    };
  });
  return { windows, global_features: log.global_features };
}

/**
 * Parses an LLM-returned JSON string. Tolerates surrounding ```json``` fences
 * even though we asked for raw JSON — LLMs slip them in routinely.
 */
function parseJsonStrict(text: string, label: string): unknown {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped);
  } catch (err) {
    const preview = stripped.slice(0, 200);
    throw new Error(`${label}: model did not return valid JSON. First 200 chars: ${preview}`);
  }
}
