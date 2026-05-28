'use server';

import { db } from '@/db/client';
import { assets, experiments, packages } from '@/db/schema';
import type { ExperimentVariant } from '@/db/schema/experiments';
import { makeId } from '@/lib/ids';
import { enqueue } from '@workers/queue';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export type NewVariantInput = {
  label?: string;
  title?: string | null;
  titleAssetId?: string | null;
  titleOptionIndex?: number | null;
  thumbnailAssetId?: string | null;
  thumbnailPath?: string | null;
};

export type CreateExperimentInput = {
  packageId: string;
  kind: 'title' | 'thumbnail' | 'title_thumbnail';
  metric?: 'views' | 'impression_ctr' | 'estimated_minutes_watched';
  rotationHours?: number;
  rounds?: number;
  minViews?: number;
  variants: NewVariantInput[];
};

/**
 * Create a self-run A/B experiment for a package's PUBLISHED YouTube video.
 * Stays in `draft` until launched. Requires the package to already be live on
 * YouTube Direct (we need the video id to rotate) and ≥ 2 variants.
 */
export async function createExperiment(input: CreateExperimentInput): Promise<{ id: string }> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, input.packageId)).limit(1);
  if (!pkg) throw new Error('createExperiment: package not found');

  const videoId = await findPublishedVideoId(input.packageId);
  if (!videoId) {
    throw new Error(
      'No published YouTube video for this package yet — publish it via YouTube Direct before running an A/B test.',
    );
  }
  if (input.variants.length < 2) {
    throw new Error('An A/B test needs at least 2 variants.');
  }

  const variants: ExperimentVariant[] = input.variants.map((v, i) => ({
    variant_index: i,
    label: v.label?.trim() || String.fromCharCode(65 + i), // A, B, C…
    title: v.title?.trim() || null,
    title_asset_id: v.titleAssetId ?? null,
    title_option_index: v.titleOptionIndex ?? null,
    thumbnail_asset_id: v.thumbnailAssetId ?? null,
    thumbnail_path: v.thumbnailPath ?? null,
    observations: [],
  }));

  // Each variant must change something, or the test is meaningless.
  if (variants.some((v) => !v.title && !v.thumbnail_path)) {
    throw new Error('Every variant must set a title and/or a thumbnail.');
  }

  const id = makeId('exp');
  await db.insert(experiments).values({
    id,
    brandId: pkg.brandId,
    packageId: input.packageId,
    videoId,
    kind: input.kind,
    metric: input.metric ?? 'views',
    rotationHours: clampInt(input.rotationHours, 48, 1, 720),
    rounds: clampInt(input.rounds, 1, 1, 5),
    minViews: clampInt(input.minViews, 50, 0, 1_000_000),
    variants,
    status: 'draft',
  });

  revalidatePath(`/packages/${input.packageId}`);
  return { id };
}

/** Launch a draft experiment: enqueue an immediate tick so variant A goes live now. */
export async function startExperiment(experimentId: string): Promise<void> {
  const [exp] = await db
    .select({ packageId: experiments.packageId, status: experiments.status })
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .limit(1);
  if (!exp) throw new Error('startExperiment: not found');
  if (exp.status !== 'draft')
    throw new Error(`Cannot start an experiment in status ${exp.status}.`);
  await enqueue({
    kind: 'experiment_tick',
    payload: { experimentId },
    idempotencyKey: `experiment_tick:${experimentId}:launch`,
  });
  revalidatePath(`/packages/${exp.packageId}`);
}

/** Stop an experiment. Leaves the currently-applied variant on the video. */
export async function cancelExperiment(experimentId: string): Promise<void> {
  const rows = await db
    .update(experiments)
    .set({ status: 'cancelled', updatedAt: sql`now()` })
    .where(eq(experiments.id, experimentId))
    .returning({ packageId: experiments.packageId });
  if (rows[0]) revalidatePath(`/packages/${rows[0].packageId}`);
}

function clampInt(v: number | undefined, dflt: number, min: number, max: number): number {
  const n = Number.isFinite(v) ? Math.round(v as number) : dflt;
  return Math.max(min, Math.min(max, n));
}

/** Find the published YouTube video id for a package, checking the asset dispatch first. */
async function findPublishedVideoId(packageId: string): Promise<string | null> {
  const rows = await db
    .select({ dispatch: assets.dispatch })
    .from(assets)
    .where(eq(assets.packageId, packageId));
  for (const r of rows) {
    const d = (r.dispatch ?? {}) as { video_id?: string; external_id?: string; target?: string };
    if (d.target === 'youtube_direct' && (d.video_id || d.external_id)) {
      return d.video_id ?? d.external_id ?? null;
    }
  }
  const [pkg] = await db
    .select({ intel: packages.intelligence })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  const vid = (pkg?.intel as { youtube?: { video_id?: string } } | null)?.youtube?.video_id;
  return vid ?? null;
}
