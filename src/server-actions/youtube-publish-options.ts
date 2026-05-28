'use server';

import { db } from '@/db/client';
import { packages } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

export type YoutubePrivacy = 'public' | 'unlisted' | 'private' | 'schedule';

export type YoutubePublishOptions = {
  privacy: YoutubePrivacy;
  /** ISO timestamp; required iff privacy === 'schedule'. */
  publishAt?: string;
};

/**
 * Persist the operator's per-package YouTube publish choice. Stored on
 * `packages.intelligence.publish_options.youtube`; read by the dispatch
 * worker's youtube_direct branch when uploading.
 *
 * For privacy === 'schedule' we validate publishAt is parseable + at least
 * 60 s in the future. YouTube's Data API requires this (and enforces
 * privacyStatus='private' on uploads with a publishAt — it auto-flips at
 * the scheduled time).
 */
export async function setYoutubePublishOptions(
  packageId: string,
  options: YoutubePublishOptions,
): Promise<void> {
  if (!packageId.startsWith('pkg_')) throw new Error('invalid packageId');
  const { privacy } = options;
  if (!['public', 'unlisted', 'private', 'schedule'].includes(privacy)) {
    throw new Error(`unknown privacy '${privacy}'`);
  }

  let publishAt: string | undefined;
  if (privacy === 'schedule') {
    if (!options.publishAt) throw new Error('publishAt required when privacy=schedule');
    const ms = Date.parse(options.publishAt);
    if (!Number.isFinite(ms)) throw new Error('publishAt is not a valid ISO timestamp');
    if (ms - Date.now() < 60_000) {
      throw new Error('publishAt must be at least 1 minute in the future');
    }
    publishAt = new Date(ms).toISOString();
  }

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`setYoutubePublishOptions: package ${packageId} not found`);

  const intel = (pkg.intelligence ?? {}) as Record<string, unknown>;
  const opts = (intel.publish_options ?? {}) as Record<string, unknown>;
  const next = {
    ...intel,
    publish_options: {
      ...opts,
      youtube: { privacy, ...(publishAt ? { publish_at: publishAt } : {}) },
    },
  };

  await db
    .update(packages)
    .set({ intelligence: next, updatedAt: sql`now()` })
    .where(eq(packages.id, packageId));
  revalidatePath(`/packages/${packageId}`);
}
