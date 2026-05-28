'use server';

import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

const ALLOWED = new Set(['manual', 'youtube_direct', 'zernio']);

/**
 * Switch how YouTube long-form videos for this brand dispatch:
 *   manual          → operator pastes URL after manual upload (default)
 *   youtube_direct  → ChannelHelm uploads via Data API (needs Connect)
 *   zernio          → handed off to Zernio (needs CF tunnel + acc_…)
 */
export async function setYoutubeDispatchTarget(
  brandId: string,
  target: string,
): Promise<void> {
  if (!brandId.startsWith('brd_')) throw new Error('invalid brandId');
  if (!ALLOWED.has(target)) {
    throw new Error(`unknown youtube_dispatch_target '${target}'`);
  }
  await db
    .update(brands)
    .set({ youtubeDispatchTarget: target, updatedAt: sql`now()` })
    .where(eq(brands.id, brandId));
  revalidatePath(`/brands/${brandId}`);
}
