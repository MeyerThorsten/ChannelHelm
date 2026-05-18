import { mkdir } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { extractFrameAt } from '../integrations/ffmpeg';
import type { JobRow } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  processingProfile: z.string().optional(),
});

/**
 * §13 step 15. Generates thumbnail concept candidates by extracting still
 * frames at the high-retention timestamps surfaced by analyze_intelligence.
 *
 *  - standard_audio_visual → 1 concept at the top hook
 *  - premium_multimodal    → 3 concepts at the top 3 hooks
 *
 * Each concept lands as a `thumbnail_concept` asset with `local_path`
 * pointing at the extracted JPG. Overlay rendering (canvas/sharp) is left
 * out of v1 — operators can hand-trim from the candidate frames.
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

  const intelligence = pkg.intelligence as Record<string, unknown>;
  const analysis = intelligence.analysis as
    | { hooks?: { window_indices: number[]; score?: number; reason?: string }[] }
    | undefined;
  const sceneLog = intelligence.scene_log as
    | { windows?: { start: number; end: number }[] }
    | undefined;

  if (!analysis?.hooks?.length || !sceneLog?.windows?.length) {
    throw new Error(
      'thumbnail_concepts: analyze_intelligence has not produced hooks yet (run it first)',
    );
  }

  const profile = processingProfile ?? pkg.processingProfile;
  const candidateCount = profile === 'premium_multimodal' ? 3 : 1;

  const ranked = [...analysis.hooks]
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, candidateCount);

  const thumbsDir = join(source.localMediaPath, 'thumbs');
  await mkdir(thumbsDir, { recursive: true });

  for (let i = 0; i < ranked.length; i++) {
    const hook = ranked[i];
    if (!hook) continue;
    const firstWindowIdx = hook.window_indices[0] ?? 0;
    const window = sceneLog.windows[firstWindowIdx] ?? sceneLog.windows[0];
    if (!window) continue;
    const timestamp = (window.start + window.end) / 2;
    const filename = `concept_${String(i + 1).padStart(2, '0')}.jpg`;
    const outputPath = join(thumbsDir, filename);

    console.log(
      `[thumbnail_concepts] concept ${i + 1}/${ranked.length} at t=${timestamp.toFixed(1)}s`,
    );
    await extractFrameAt({
      inputPath: join(source.localMediaPath, 'original.mp4'),
      timestamp,
      outputPath,
    });

    await db.insert(assets).values({
      packageId,
      brandId: pkg.brandId,
      type: 'thumbnail_concept',
      status: 'ready_for_review',
      approvalRequired: true,
      payload: {
        rank: i + 1,
        timestamp,
        local_path: outputPath,
        public_url: null,
        hook_reason: hook.reason ?? null,
        hook_score: hook.score ?? null,
      },
      provenance: {
        provider: 'ffmpeg',
        model: 'ffmpeg-8.1',
        host: hostname(),
        prompt_version: null,
        input_refs: [`video:${sourceId}`, `analysis:${packageId}`],
        generated_at: new Date().toISOString(),
        profile,
      },
    });
  }
}
