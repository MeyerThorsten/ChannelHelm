import { mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { renderVerticalClip } from '../integrations/ffmpeg';
import type { JobRow } from '../queue';

const Payload = z.object({
  planAssetId: z.string().regex(/^ast_/),
  clipIndex: z.number().int().nonnegative(),
});

/**
 * §13 step 14. Takes a `short_clip_plan` asset (a blueprint produced by
 * analyze_intelligence) plus a clip index into the plan, renders the
 * corresponding vertical clip via ffmpeg, and INSERTs a new
 * `rendered_short_clip` asset.
 *
 * Per CLAUDE.md, *_plan assets are NEVER dispatched — they're internal.
 * Only `rendered_*` assets carry a real `local_path` / `public_url` and
 * are eligible for dispatch.
 */
export async function run(job: JobRow): Promise<void> {
  const { planAssetId, clipIndex } = Payload.parse(job.payload);

  const [plan] = await db.select().from(assets).where(eq(assets.id, planAssetId)).limit(1);
  if (!plan) throw new Error(`clip_render: plan asset ${planAssetId} not found`);
  if (plan.type !== 'short_clip_plan' && plan.type !== 'long_clip_plan') {
    throw new Error(`clip_render: ${planAssetId} is not a *_plan asset (type=${plan.type})`);
  }

  const payload = plan.payload as { clips?: Clip[] };
  const clip = payload.clips?.[clipIndex];
  if (!clip) throw new Error(`clip_render: plan ${planAssetId} has no clip at index ${clipIndex}`);

  // Trace back to the source for the input video via the plan's package.
  const [joined] = await db
    .select({ source: sources })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, plan.packageId))
    .limit(1);
  const source = joined?.source;
  if (!source?.localMediaPath) {
    throw new Error(`clip_render: could not resolve source localMediaPath for plan ${planAssetId}`);
  }

  const videoPath = join(source.localMediaPath, 'original.mp4');
  const clipsDir = join(source.localMediaPath, 'clips');
  await mkdir(clipsDir, { recursive: true });

  const safeIndex = String(clipIndex).padStart(3, '0');
  const baseName = `clip_${safeIndex}`;
  const outputPath = join(clipsDir, `${baseName}.mp4`);

  console.log(
    `[clip_render] plan=${planAssetId} clip=${clipIndex} ` +
      `[${clip.start}s-${clip.end}s] → ${outputPath}`,
  );

  let subtitlePath: string | undefined;
  if (clip.subtitles && Array.isArray(clip.subtitles) && clip.subtitles.length > 0) {
    subtitlePath = join(clipsDir, `${baseName}.vtt`);
    await writeFile(subtitlePath, serializeVtt(clip.subtitles, clip.start), 'utf8');
  }

  await renderVerticalClip({
    inputPath: videoPath,
    start: clip.start,
    end: clip.end,
    outputPath,
    crop: clip.crop ?? 'center-crop',
    subtitleVttPath: subtitlePath,
  });

  const provenance = {
    provider: 'ffmpeg',
    model: 'ffmpeg-8.1',
    host: hostname(),
    prompt_version: null,
    input_refs: [`plan_asset:${planAssetId}`, `video:${source.id}`],
    generated_at: new Date().toISOString(),
    profile: null,
  };

  await db.insert(assets).values({
    packageId: plan.packageId,
    brandId: plan.brandId,
    type: 'rendered_short_clip',
    status: 'ready_for_review',
    approvalRequired: true,
    payload: {
      plan_asset_id: planAssetId,
      clip_index: clipIndex,
      start: clip.start,
      end: clip.end,
      duration: clip.end - clip.start,
      local_path: outputPath,
      public_url: null, // filled when Cloudflare Tunnel routes /media/*
      crop: clip.crop ?? 'center-crop',
      title: clip.title ?? null,
      caption: clip.caption ?? null,
    },
    provenance,
  });
}

type Subtitle = { start: number; end: number; text: string };

type Clip = {
  start: number;
  end: number;
  crop?: 'center-crop' | 'pillarbox';
  title?: string;
  caption?: string;
  subtitles?: Subtitle[];
};

function serializeVtt(subs: Subtitle[], clipStart: number): string {
  const fmt = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = s - m * 60;
    return `${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
  };
  const lines = ['WEBVTT', ''];
  for (const sub of subs) {
    const start = Math.max(sub.start - clipStart, 0);
    const end = Math.max(sub.end - clipStart, start + 0.1);
    lines.push(`${fmt(start)} --> ${fmt(end)}`);
    lines.push(sub.text);
    lines.push('');
  }
  return lines.join('\n');
}
