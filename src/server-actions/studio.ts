'use server';

import { rm } from 'node:fs/promises';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import { resolveMediaPath } from '@/lib/media-path';
import { enqueue } from '@workers/queue';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

/** Re-run the pipeline from ingest for this package. */
export async function retryPackage(packageId: string): Promise<void> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`retryPackage: ${packageId} not found`);
  // Clear the old ingest idempotency row so the job can be re-enqueued.
  await db.execute(
    sql`DELETE FROM jobs WHERE kind = 'ingest' AND idempotency_key = ${`ingest:${pkg.sourceId}`}`,
  );
  await db
    .update(packages)
    .set({ status: 'draft', updatedAt: sql`now()` })
    .where(eq(packages.id, packageId));
  await enqueue({
    kind: 'ingest',
    payload: { sourceId: pkg.sourceId, packageId },
    idempotencyKey: `ingest:${pkg.sourceId}`,
  });
  revalidatePath(`/packages/${packageId}`);
}

/** Delete a package, its assets, queued jobs, and on-disk media. */
export async function deletePackage(packageId: string): Promise<void> {
  const [joined] = await db
    .select({ pkg: packages, source: sources })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!joined) throw new Error(`deletePackage: ${packageId} not found`);
  const { pkg, source } = joined;

  // Best-effort media cleanup, guarded to MEDIA_ROOT.
  if (source.localMediaPath) {
    const safe = resolveMediaPath(source.localMediaPath);
    if (safe) await rm(safe, { recursive: true, force: true });
  }

  await db.execute(
    sql`DELETE FROM jobs WHERE payload->>'sourceId' = ${pkg.sourceId} OR payload->>'packageId' = ${packageId}`,
  );
  await db.delete(assets).where(eq(assets.packageId, packageId));
  await db.delete(packages).where(eq(packages.id, packageId));
  // Source may be shared in theory; here it's 1:1, safe to drop.
  await db.delete(sources).where(eq(sources.id, pkg.sourceId));

  revalidatePath('/');
  redirect('/');
}

/** Persist which title the operator selected (index into the titles array). */
export async function selectTitle(assetId: string, index: number): Promise<void> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`selectTitle: ${assetId} not found`);
  const payload = { ...(asset.payload as Record<string, unknown>), selectedIndex: index };
  await db.update(assets).set({ payload, updatedAt: sql`now()` }).where(eq(assets.id, assetId));
  revalidatePath(`/packages/${asset.packageId}`);
}

/** Enqueue (or re-enqueue) thumbnail generation. */
export async function generateThumbnails(
  packageId: string,
  sourceId: string,
  faces: string,
): Promise<void> {
  await db.execute(
    sql`DELETE FROM jobs WHERE kind = 'thumbnail_concepts' AND idempotency_key = ${`thumbnail_concepts:${packageId}`}`,
  );
  await enqueue({
    kind: 'thumbnail_concepts',
    payload: { sourceId, packageId, faces },
    idempotencyKey: `thumbnail_concepts:${packageId}`,
  });
  revalidatePath(`/packages/${packageId}`);
}
