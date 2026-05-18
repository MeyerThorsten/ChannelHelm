'use server';

import { db } from '@/db/client';
import { assets, packages } from '@/db/schema';
import { enqueue } from '@workers/queue';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

/**
 * Mark a single asset approved.
 *
 * Routing:
 *   *_plan asset      → enqueue one `clip_render` job per entry in
 *                        payload.clips. The plan stays `approved` but is
 *                        not dispatched (per CLAUDE.md). The rendered_*
 *                        outputs then go through their own approval.
 *   any other asset    → enqueue a single `dispatch` job.
 */
export async function approveAsset(assetId: string): Promise<void> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`approveAsset: ${assetId} not found`);
  await db
    .update(assets)
    .set({ status: 'approved', updatedAt: sql`now()` })
    .where(eq(assets.id, assetId));

  if (asset.type.endsWith('_plan')) {
    const clips = (asset.payload as { clips?: unknown[] }).clips ?? [];
    for (let i = 0; i < clips.length; i++) {
      await enqueue({
        kind: 'clip_render',
        payload: { planAssetId: asset.id, clipIndex: i },
        idempotencyKey: `clip_render:${asset.id}:${i}`,
      });
    }
  } else {
    await enqueue({
      kind: 'dispatch',
      payload: { assetId },
      idempotencyKey: `dispatch:${assetId}`,
    });
  }
  revalidatePath(`/packages/${asset.packageId}`);
}

export async function rejectAsset(assetId: string): Promise<void> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`rejectAsset: ${assetId} not found`);
  await db
    .update(assets)
    .set({ status: 'rejected', updatedAt: sql`now()` })
    .where(eq(assets.id, assetId));
  revalidatePath(`/packages/${asset.packageId}`);
}

/**
 * Approve the whole package and every asset that's still in
 * ready_for_review (excluding *_plan assets, which are internal).
 * Enqueues a dispatch job per approved asset.
 */
export async function approvePackage(packageId: string, operator: string): Promise<void> {
  const allAssets = await db.select().from(assets).where(eq(assets.packageId, packageId));
  const dispatchable = allAssets.filter((a) => !a.type.endsWith('_plan'));
  await db
    .update(packages)
    .set({
      status: 'approved',
      approvedAt: sql`now()`,
      approvedBy: operator,
      updatedAt: sql`now()`,
    })
    .where(eq(packages.id, packageId));
  for (const a of dispatchable) {
    if (a.status === 'ready_for_review' || a.status === 'draft') {
      await db
        .update(assets)
        .set({ status: 'approved', updatedAt: sql`now()` })
        .where(eq(assets.id, a.id));
      await enqueue({
        kind: 'dispatch',
        payload: { assetId: a.id },
        idempotencyKey: `dispatch:${a.id}`,
      });
    }
  }
  // Plans get one clip_render job per clip entry — bulk-approval treats
  // these specially so rendered_* assets land alongside the text ones.
  const plans = allAssets.filter(
    (a) => a.type.endsWith('_plan') && (a.status === 'ready_for_review' || a.status === 'draft'),
  );
  for (const plan of plans) {
    await db
      .update(assets)
      .set({ status: 'approved', updatedAt: sql`now()` })
      .where(eq(assets.id, plan.id));
    const clips = (plan.payload as { clips?: unknown[] }).clips ?? [];
    for (let i = 0; i < clips.length; i++) {
      await enqueue({
        kind: 'clip_render',
        payload: { planAssetId: plan.id, clipIndex: i },
        idempotencyKey: `clip_render:${plan.id}:${i}`,
      });
    }
  }
  revalidatePath(`/packages/${packageId}`);
  revalidatePath('/');
}
