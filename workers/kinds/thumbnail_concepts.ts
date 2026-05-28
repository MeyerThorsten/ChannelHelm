import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { assets, brands, packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { extractFrameAt, renderThumbnail } from '../integrations/ffmpeg';
import { downloadImage, getImageProvider } from '../integrations/image/get_image_provider';
import type { ImageProvider } from '../integrations/image/types';
import { complete } from '../integrations/lm_studio';
import { loadPrompt, render } from '../integrations/prompts';
import type { JobRow } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

type Hook = { window_indices: number[]; score?: number; reason?: string };
type SceneWindow = { start: number; end: number };

/**
 * §13 step 15. Produces thumbnail concept candidates.
 *
 * PRIMARY path (when an image provider is configured at /providers,
 * category=image — e.g. Runware): generate AI thumbnail IMAGES. An LLM turns
 * the package analysis into distinct visual concepts + punchy headlines; each
 * concept is rendered by the image provider, downloaded to disk, and emitted
 * as TWO `thumbnail_concept` assets — a plain image and a headline-overlay
 * variant (text composited via ffmpeg drawtext). The operator picks one.
 *
 * FALLBACK path (no image provider configured): extract still frames at the
 * high-retention hook timestamps surfaced by analyze_intelligence — the
 * original v1 behaviour, so the pipeline still produces thumbnails with zero
 * extra config / cost.
 */
export async function run(job: JobRow): Promise<void> {
  const { sourceId, packageId, processingProfile } = Payload.parse(job.payload);

  const [joined] = await db
    .select({ pkg: packages, source: sources })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!joined) throw new Error(`thumbnail_concepts: package ${packageId} not found`);
  const { pkg, source } = joined;
  if (!source.localMediaPath) {
    throw new Error('thumbnail_concepts: source missing local_media_path');
  }

  const profile = processingProfile ?? pkg.processingProfile;
  const intelligence = pkg.intelligence as Record<string, unknown>;
  const analysis = intelligence.analysis as
    | { hooks?: Hook[]; topics?: unknown; retention?: unknown }
    | undefined;

  const thumbsDir = join(source.localMediaPath, 'thumbs');
  await mkdir(thumbsDir, { recursive: true });

  const candidateCount = profile === 'premium_multimodal' ? 3 : 2;

  // PRIMARY: AI image generation when an image provider is configured.
  const imageProvider = await getImageProvider(profile);
  if (imageProvider) {
    try {
      await generateAiThumbnails({
        provider: imageProvider,
        packageId,
        sourceId,
        brandId: pkg.brandId,
        title: source.title ?? source.originUrl ?? packageId,
        analysis,
        profile,
        thumbsDir,
        candidateCount,
      });
      return;
    } catch (err) {
      // Don't fail the package over thumbnails — fall back to frame extraction.
      console.warn(
        `[thumbnail_concepts] AI generation failed (${
          err instanceof Error ? err.message : String(err)
        }) — falling back to frame extraction`,
      );
    }
  } else {
    console.log('[thumbnail_concepts] no image provider configured — using frame extraction');
  }

  // FALLBACK: frame extraction at hook timestamps.
  await extractFrameThumbnails({
    packageId,
    sourceId,
    brandId: pkg.brandId,
    localMediaPath: source.localMediaPath,
    analysis,
    sceneLog: intelligence.scene_log as { windows?: SceneWindow[] } | undefined,
    profile,
    thumbsDir,
    candidateCount,
  });
}

// ─── AI generation path ─────────────────────────────────────────────────────

async function generateAiThumbnails(opts: {
  provider: ImageProvider;
  packageId: string;
  sourceId: string;
  brandId: string;
  title: string;
  analysis: unknown;
  profile: string;
  thumbsDir: string;
  candidateCount: number;
}): Promise<void> {
  const { provider, packageId, sourceId, brandId, title, analysis, profile, thumbsDir } = opts;

  const [brand] = await db.select().from(brands).where(eq(brands.id, brandId)).limit(1);

  // LLM turns the analysis into N distinct visual concepts + headlines.
  const prompt = await loadPrompt('thumbnail_image', 1);
  const user = render(prompt, {
    // Explicit snake_case vars so {{brand.voice_profile}} etc. resolve
    // regardless of the Drizzle camelCase column names.
    brand: { name: brand?.name ?? 'the channel', voice_profile: brand?.voiceProfile ?? {} },
    analysis: analysis ?? {},
    title,
    count: opts.candidateCount,
  });
  const result = await complete({
    profile,
    system: prompt.system ?? undefined,
    user,
    promptVersion: `${prompt.name}.v${prompt.version}`,
    inputRefs: [`analysis:${packageId}`],
    maxTokens: 1200,
    temperature: 0.8,
  });

  const concepts = parseConcepts(result.text).slice(0, opts.candidateCount);
  if (concepts.length === 0) throw new Error('LLM returned no thumbnail concepts');

  const promptVersion = `${prompt.name}.v${prompt.version}`;
  for (let i = 0; i < concepts.length; i++) {
    const concept = concepts[i];
    if (!concept) continue;
    const idx = String(i + 1).padStart(2, '0');

    const [image] = await provider.generateImages({
      prompt: concept.visual_prompt,
      width: 1280,
      height: 720,
      numberResults: 1,
    });
    if (!image) continue;

    // Download the provider's CDN result, then render the finished
    // thumbnail(s) — the YouTube uploader + /api/media need bytes on disk.
    const srcPath = join(thumbsDir, `concept_${idx}_src.jpg`);
    await downloadImage(image.imageUrl, srcPath);

    const provenance = {
      provider: provider.getType(),
      model: provider.getModel(),
      host: hostname(),
      prompt_version: promptVersion,
      input_refs: [`analysis:${packageId}`, `image:${provider.getName()}`],
      generated_at: new Date().toISOString(),
      profile,
    };

    // Plain variant — scaled image, no text.
    const plainPath = join(thumbsDir, `concept_${idx}.jpg`);
    await renderThumbnail({ inputPath: srcPath, outputPath: plainPath });
    await insertThumb({
      packageId,
      brandId,
      rank: i + 1,
      variant: 'plain',
      localPath: plainPath,
      headline: null,
      visualPrompt: concept.visual_prompt,
      cost: image.cost ?? null,
      provenance,
    });

    // Headline variant — best-effort (drawtext needs a font; skip on failure).
    if (concept.headline?.trim()) {
      const textPath = join(thumbsDir, `concept_${idx}_headline.jpg`);
      try {
        await renderThumbnail({
          inputPath: srcPath,
          outputPath: textPath,
          headline: concept.headline,
        });
        await insertThumb({
          packageId,
          brandId,
          rank: i + 1,
          variant: 'headline',
          localPath: textPath,
          headline: concept.headline,
          visualPrompt: concept.visual_prompt,
          cost: null, // cost counted once on the plain variant
          provenance,
        });
      } catch (err) {
        console.warn(
          `[thumbnail_concepts] headline overlay failed for concept ${idx} (${
            err instanceof Error ? err.message : String(err)
          }) — keeping plain variant only`,
        );
      }
    }
  }
  console.log(
    `[thumbnail_concepts] generated ${concepts.length} AI concept(s) via ${provider.getName()} for ${packageId}`,
  );
}

async function insertThumb(opts: {
  packageId: string;
  brandId: string;
  rank: number;
  variant: 'plain' | 'headline';
  localPath: string;
  headline: string | null;
  visualPrompt: string;
  cost: number | null;
  provenance: Record<string, unknown>;
}): Promise<void> {
  await db.insert(assets).values({
    packageId: opts.packageId,
    brandId: opts.brandId,
    type: 'thumbnail_concept',
    status: 'ready_for_review',
    approvalRequired: true,
    payload: {
      rank: opts.rank,
      variant: opts.variant,
      local_path: opts.localPath,
      public_url: null,
      headline: opts.headline,
      visual_prompt: opts.visualPrompt,
      generated: true,
      cost_usd: opts.cost,
    },
    provenance: opts.provenance,
  });
}

/**
 * Parse the LLM's concept array. Tolerates ```json fences and leading prose;
 * extracts the first JSON array in the response. Exported for tests.
 */
export function parseConcepts(text: string): { visual_prompt: string; headline?: string }[] {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  const slice = start >= 0 && end > start ? stripped.slice(start, end + 1) : stripped;
  try {
    const parsed = JSON.parse(slice);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((c): c is { visual_prompt: string; headline?: string } =>
        Boolean(c && typeof (c as { visual_prompt?: unknown }).visual_prompt === 'string'),
      )
      .map((c) => ({
        visual_prompt: String(c.visual_prompt),
        headline: typeof c.headline === 'string' ? c.headline : undefined,
      }));
  } catch {
    return [];
  }
}

// ─── frame-extraction fallback (original v1 behaviour) ──────────────────────

async function extractFrameThumbnails(opts: {
  packageId: string;
  sourceId: string;
  brandId: string;
  localMediaPath: string;
  analysis: { hooks?: Hook[] } | undefined;
  sceneLog: { windows?: SceneWindow[] } | undefined;
  profile: string;
  thumbsDir: string;
  candidateCount: number;
}): Promise<void> {
  const { analysis, sceneLog, localMediaPath, thumbsDir } = opts;
  if (!analysis?.hooks?.length || !sceneLog?.windows?.length) {
    throw new Error(
      'thumbnail_concepts: no image provider and analyze_intelligence has not produced hooks yet',
    );
  }

  const ranked = [...analysis.hooks]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, opts.candidateCount);

  for (let i = 0; i < ranked.length; i++) {
    const hook = ranked[i];
    if (!hook) continue;
    const firstWindowIdx = hook.window_indices[0] ?? 0;
    const window = sceneLog.windows[firstWindowIdx] ?? sceneLog.windows[0];
    if (!window) continue;
    const timestamp = (window.start + window.end) / 2;
    const outputPath = join(thumbsDir, `concept_${String(i + 1).padStart(2, '0')}.jpg`);

    console.log(
      `[thumbnail_concepts] frame concept ${i + 1}/${ranked.length} at t=${timestamp.toFixed(1)}s`,
    );
    await extractFrameAt({
      inputPath: join(localMediaPath, 'original.mp4'),
      timestamp,
      outputPath,
    });

    await db.insert(assets).values({
      packageId: opts.packageId,
      brandId: opts.brandId,
      type: 'thumbnail_concept',
      status: 'ready_for_review',
      approvalRequired: true,
      payload: {
        rank: i + 1,
        variant: 'frame',
        timestamp,
        local_path: outputPath,
        public_url: null,
        hook_reason: hook.reason ?? null,
        hook_score: hook.score ?? null,
        generated: false,
      },
      provenance: {
        provider: 'ffmpeg',
        model: 'ffmpeg-8.1',
        host: hostname(),
        prompt_version: null,
        input_refs: [`video:${opts.sourceId}`, `analysis:${opts.packageId}`],
        generated_at: new Date().toISOString(),
        profile: opts.profile,
      },
    });
  }
}
