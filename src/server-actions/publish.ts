'use server';

import { db } from '@/db/client';
import { assets } from '@/db/schema';
import { enqueue } from '@workers/queue';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

/**
 * Approve + dispatch a single asset to its platform via LATE/Zernio (or
 * DojoClaw for article_brief). Mirrors the approval flow: flips the asset to
 * approved and enqueues `dispatch`, which routes by type. The dispatch worker
 * + zernio integration map the asset to the right LATE network.
 *
 * Throws a friendly error when the relevant API key isn't configured so the
 * studio surfaces it inline rather than silently queueing a job that will
 * fail in the worker.
 */
export async function publishAsset(assetId: string): Promise<void> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`publishAsset: ${assetId} not found`);
  // Idempotent: if the dispatch worker already moved this asset past
  // `approved`, do nothing. Re-clicking a row should not reset state.
  if (asset.status === 'dispatched' || asset.status === 'published') {
    return;
  }
  if (asset.type.endsWith('_plan')) {
    throw new Error('Plans are not publishable — render the clips first, then publish those.');
  }

  // Routed-to-LATE types check ZERNIO_API_KEY; manual types (youtube_*,
  // thumbnail_concept, newsletter_summary, transcript) skip the check.
  const isManualOnly =
    asset.type.startsWith('youtube_') ||
    asset.type === 'thumbnail_concept' ||
    asset.type === 'newsletter_summary' ||
    asset.type === 'transcript';
  const usesLate = !isManualOnly && asset.type !== 'article_brief';
  if (usesLate && !process.env.ZERNIO_API_KEY) {
    throw new Error('Set ZERNIO_API_KEY (LATE) and connect the account before publishing.');
  }
  if (asset.type === 'article_brief' && !process.env.DOJOCLAW_API_KEY) {
    throw new Error('Set DOJOCLAW_API_KEY before publishing a brief to DojoClaw.');
  }

  // Only flip ready_for_review → approved. Don't re-stamp `approved` rows
  // (the dispatch worker is the only thing allowed to move them onwards).
  if (asset.status === 'ready_for_review') {
    await db
      .update(assets)
      .set({ status: 'approved', updatedAt: sql`now()` })
      .where(eq(assets.id, assetId));
  }
  await enqueue({
    kind: 'dispatch',
    payload: { assetId },
    idempotencyKey: `dispatch:${assetId}`,
  });
  revalidatePath(`/packages/${asset.packageId}`);
}
