import { access, mkdir, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import { type AssStyle, serializeAss } from '@/lib/ass-subtitles';
import { type WordTiming, flattenTranscriptWords, snapToWordBoundary } from '@/lib/word-snap';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { renderVerticalClip } from '../integrations/ffmpeg';
import type { JobRow } from '../queue';

const Payload = z.object({
  planAssetId: z.string().regex(/^ast_/),
  clipIndex: z.number().int().nonnegative(),
});

/**
 * §13 step 14. Takes a `*_clip_plan` asset (a blueprint produced by
 * analyze_intelligence) plus a clip index into the plan, renders the
 * corresponding vertical/horizontal clip via ffmpeg, and UPSERTs the
 * `rendered_short_clip` / `rendered_long_clip` asset.
 *
 * UPSERT semantics (added round 2): re-renders update the existing row
 * keyed by `(plan_asset_id, clip_index)` rather than INSERTing fresh.
 * The plan's `clips[i].render_rev` is the monotonic revision number;
 * the worker writes the same value into the rendered row and skips
 * when the rendered row's render_rev >= plan's (idempotent crash
 * recovery). Operator edits to title/description/tags/styling/trim
 * live on the plan and get COPIED into the rendered row at render time.
 *
 * Word-snap is applied defensively before ffmpeg `-ss` so any trim
 * that came from a non-UI source still produces a clip starting on a
 * whole word. See `src/lib/word-snap.ts`.
 *
 * ASS subtitles (from `src/lib/ass-subtitles.ts`) are emitted instead
 * of VTT when the clip has a `styling` block — gives us inline word
 * highlighting, banner mode, etc.
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
  if (clip.deleted) {
    throw new Error(`clip_render: plan ${planAssetId} clip ${clipIndex} has been deleted`);
  }

  // Trace back to the source for the input video via the plan's package.
  // Also pull the package's intelligence so we can extract word timings
  // for word-snap defence + ASS subtitle generation.
  const [joined] = await db
    .select({ source: sources, intelligence: packages.intelligence })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, plan.packageId))
    .limit(1);
  const source = joined?.source;
  if (!source?.localMediaPath) {
    throw new Error(`clip_render: could not resolve source localMediaPath for plan ${planAssetId}`);
  }

  // Storage lifecycle (Option B): read original.mp4 from local first;
  // fall back to source.archive_path when the source has been moved off
  // MEDIA_ROOT. The rendered clip is always written back to the LOCAL
  // clipsDir so dispatch's MEDIA_ROOT-relative URL signing still resolves —
  // the localMediaPath directory itself isn't removed at archive time,
  // only its `original.mp4` + `clips/` contents.
  let videoPath = join(source.localMediaPath, 'original.mp4');
  try {
    await access(videoPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' && source.archivePath) {
      const archived = join(source.archivePath, 'original.mp4');
      try {
        await access(archived);
        videoPath = archived;
        console.log(`[clip_render] reading source from archive: ${archived}`);
      } catch {
        throw new Error(
          `clip_render: original.mp4 missing both locally (${source.localMediaPath}) and in archive (${source.archivePath})`,
        );
      }
    } else {
      throw err;
    }
  }
  const clipsDir = join(source.localMediaPath, 'clips');
  await mkdir(clipsDir, { recursive: true });

  const safeIndex = String(clipIndex).padStart(3, '0');
  const baseName = `clip_${safeIndex}`;
  const outputPath = join(clipsDir, `${baseName}.mp4`);

  // Word timings for defensive snap + ASS subtitle generation. May be
  // empty when the package was processed under `fast_audio_only`
  // without word_timestamps; we degrade gracefully (no snap, no ASS).
  const transcript =
    ((joined?.intelligence as Record<string, unknown> | undefined)?.transcript as
      | { segments?: unknown[] }
      | undefined) ?? {};
  const words = flattenTranscriptWords(transcript);

  // Resolve effective trim: operator override on the plan wins; otherwise
  // the LLM-picked start/end. Defensive word-snap regardless of source —
  // ffmpeg's `-ss` has sub-frame imprecision and we want clips to start
  // on a whole word every time.
  const rawStart = clip.trim?.start ?? clip.start;
  const rawEnd = clip.trim?.end ?? clip.end;
  const effectiveStart = words.length > 0 ? snapToWordBoundary(rawStart, words, 'start') : rawStart;
  const effectiveEnd = words.length > 0 ? snapToWordBoundary(rawEnd, words, 'end') : rawEnd;

  console.log(
    `[clip_render] plan=${planAssetId} clip=${clipIndex} ` +
      `[${effectiveStart.toFixed(2)}s-${effectiveEnd.toFixed(2)}s] rev=${clip.render_rev ?? 0} → ${outputPath}`,
  );

  // §2.3 / §6: short_clip_plan → vertical rendered_short_clip; long_clip_plan
  // → horizontal rendered_long_clip. Dimensions + output type branch on it.
  const isLong = plan.type === 'long_clip_plan';
  const width = isLong ? 1920 : 1080;
  const height = isLong ? 1080 : 1920;
  const renderedType = isLong ? 'rendered_long_clip' : 'rendered_short_clip';
  const defaultPlatforms = isLong ? ['youtube'] : ['tiktok', 'instagram', 'youtube'];

  // UPSERT target keyed by (plan_asset_id, clip_index). Check before doing
  // any ffmpeg work so a duplicate/replay job cannot overwrite bytes for
  // a rendered asset that has already been dispatched or published.
  const [existing] = await db
    .select({ id: assets.id, payload: assets.payload, status: assets.status })
    .from(assets)
    .where(
      and(
        eq(assets.packageId, plan.packageId),
        eq(assets.type, renderedType),
        sql`(${assets.payload} ->> 'plan_asset_id') = ${planAssetId}`,
        sql`(${assets.payload} ->> 'clip_index')::int = ${clipIndex}`,
      ),
    )
    .limit(1);

  if (existing && isTerminalRenderedStatus(existing.status)) {
    throw new Error(
      `clip_render: refusing to overwrite ${existing.status} rendered asset ${existing.id}`,
    );
  }

  if (existing) {
    const existingRev =
      Number((existing.payload as { render_rev?: number } | undefined)?.render_rev) || 0;
    if (existingRev >= (clip.render_rev ?? 0) && existingRev > 0) {
      console.log(
        `[clip_render] skip ${existing.id} — existing render_rev=${existingRev} >= plan render_rev=${clip.render_rev ?? 0}`,
      );
      if (clip.pending_render) {
        await clearPendingRender(planAssetId, payload, clipIndex);
      }
      return;
    }
  }

  // Subtitles. Three branches in priority order:
  //   1. operator picked a `styling` block → emit ASS with word-level overrides
  //   2. legacy clip.subtitles array (v1 plans) → emit VTT
  //   3. no subtitles at all → no -vf subtitle filter
  let subtitleAssPath: string | undefined;
  let subtitleVttPath: string | undefined;
  if (clip.styling && words.length > 0) {
    subtitleAssPath = join(clipsDir, `${baseName}.ass`);
    const ass = serializeAss({
      clipWidth: width,
      clipHeight: height,
      clipStartSeconds: effectiveStart,
      clipEndSeconds: effectiveEnd,
      words,
      style: clip.styling,
    });
    await writeFile(subtitleAssPath, ass, 'utf8');
  } else if (clip.subtitles && Array.isArray(clip.subtitles) && clip.subtitles.length > 0) {
    subtitleVttPath = join(clipsDir, `${baseName}.vtt`);
    await writeFile(subtitleVttPath, serializeVtt(clip.subtitles, effectiveStart), 'utf8');
  }

  await renderVerticalClip({
    inputPath: videoPath,
    start: effectiveStart,
    end: effectiveEnd,
    outputPath,
    width,
    height,
    crop: clip.crop ?? 'center-crop',
    ...(subtitleAssPath ? { subtitleAssPath } : {}),
    ...(subtitleVttPath ? { subtitleVttPath } : {}),
  });

  const provenance = {
    provider: 'ffmpeg',
    model: 'ffmpeg-8.1',
    host: hostname(),
    prompt_version: null,
    input_refs: [
      `plan_asset:${planAssetId}`,
      `plan_rev:${clip.render_rev ?? 0}`,
      `video:${source.id}`,
    ],
    generated_at: new Date().toISOString(),
    profile: null,
  };

  // Mirror the plan's editorial + styling fields into the rendered row so
  // downstream readers (Studio cards, dispatch worker) don't have to traverse.
  const renderedPayload = {
    plan_asset_id: planAssetId,
    clip_index: clipIndex,
    start: effectiveStart,
    end: effectiveEnd,
    duration_seconds: effectiveEnd - effectiveStart,
    width,
    height,
    platforms: defaultPlatforms,
    local_path: outputPath,
    public_url: null, // minted just-in-time (signed) at dispatch — §9.4
    crop: clip.crop ?? 'center-crop',
    title: clip.title ?? null,
    caption: clip.caption ?? null,
    description: clip.description ?? null,
    tags: Array.isArray(clip.tags) ? clip.tags : [],
    hashtags: Array.isArray(clip.hashtags) ? clip.hashtags : [],
    media_refs: Array.isArray(clip.media_refs) ? clip.media_refs : [],
    ...(clip.styling ? { styling: clip.styling } : {}),
    ...(clip.publish_options ? { publish_options: clip.publish_options } : {}),
    render_rev: clip.render_rev ?? 0,
    pending_render: false,
  };

  if (existing) {
    await db
      .update(assets)
      .set({
        payload: renderedPayload,
        provenance,
        // Only flip back to ready_for_review if it was approved but not yet
        // dispatched. Terminal statuses are guarded before ffmpeg runs.
        status: existing.status === 'approved' ? 'ready_for_review' : existing.status,
        updatedAt: sql`now()`,
      })
      .where(eq(assets.id, existing.id));
    console.log(`[clip_render] updated ${existing.id} (rev ${clip.render_rev ?? 0})`);
  } else {
    const [inserted] = await db
      .insert(assets)
      .values({
        packageId: plan.packageId,
        brandId: plan.brandId,
        type: renderedType,
        status: 'ready_for_review',
        approvalRequired: true,
        payload: renderedPayload,
        provenance,
      })
      .returning({ id: assets.id });
    console.log(`[clip_render] inserted ${inserted?.id} (rev ${clip.render_rev ?? 0})`);
  }

  // Clear the pending_render flag on the plan's clip entry (operator-set
  // when they clicked "Render"; we own clearing it after success).
  if (clip.pending_render) {
    await clearPendingRender(planAssetId, payload, clipIndex);
  }
}

type Subtitle = { start: number; end: number; text: string };

type Clip = {
  start: number;
  end: number;
  crop?: 'center-crop' | 'pillarbox';
  title?: string;
  caption?: string;
  description?: string;
  tags?: string[];
  subtitles?: Subtitle[];
  hashtags?: string[];
  media_refs?: string[];
  // Editor-set fields:
  trim?: { start: number; end: number };
  styling?: AssStyle;
  description_links?: { label: string; url: string }[];
  b_roll_enabled?: boolean;
  publish_options?: {
    platforms?: { youtube?: boolean; tiktok?: boolean; instagram?: boolean };
    privacy?: 'public' | 'unlisted' | 'private' | 'schedule';
    publish_at?: string;
  };
  render_rev?: number;
  pending_render?: boolean;
  deleted?: boolean;
};

function isTerminalRenderedStatus(status: string): boolean {
  return status === 'dispatched' || status === 'published';
}

async function clearPendingRender(
  planAssetId: string,
  payload: { clips?: Clip[] },
  clipIndex: number,
): Promise<void> {
  const clips = (payload.clips ?? []).map((c, i) =>
    i === clipIndex ? { ...c, pending_render: false } : c,
  );
  await db
    .update(assets)
    .set({ payload: { ...payload, clips }, updatedAt: sql`now()` })
    .where(eq(assets.id, planAssetId));
}

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

// Re-export the WordTiming type for callers that need it.
export type { WordTiming };
