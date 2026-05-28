'use server';

import { rm } from 'node:fs/promises';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import { resolveMediaPath } from '@/lib/media-path';
import { ProcessingProfile } from '@/lib/schemas';
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

/**
 * Backlog Revival (v1.1) — re-mine an existing source through the pipeline
 * with the current prompts, optionally under a cheaper profile
 * (`transcription_only` re-mines audio only). Unlike `retryPackage` (which
 * only clears the ingest idempotency row, so completed downstream stages
 * dedupe and never re-run), revival clears EVERY job for the source so the
 * whole pipeline runs fresh. `generate_asset` UPSERTs by (package, type),
 * so regenerated assets overwrite the old ones in place — fresh kit, same
 * package id, dispatch history preserved.
 *
 * Requires the source media to still be present (local or archived). A
 * hard-deleted source (see `deleteSourceVideo`) will fail at ingest with a
 * clean error.
 */
export async function reviveSource(packageId: string, profile?: string): Promise<void> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`reviveSource: ${packageId} not found`);

  const nextProfile = profile ? ProcessingProfile.parse(profile) : pkg.processingProfile;

  // Clear ALL jobs for this source + package so every stage re-runs (the
  // per-source idempotency keys would otherwise dedupe against the old
  // completed jobs and skip the work).
  await db.execute(
    sql`DELETE FROM jobs WHERE payload->>'sourceId' = ${pkg.sourceId} OR payload->>'packageId' = ${packageId}`,
  );

  await db
    .update(packages)
    .set({ processingProfile: nextProfile, status: 'draft', updatedAt: sql`now()` })
    .where(eq(packages.id, packageId));

  await enqueue({
    kind: 'ingest',
    payload: { sourceId: pkg.sourceId, packageId },
    idempotencyKey: `ingest:${pkg.sourceId}`,
  });

  revalidatePath(`/packages/${packageId}`);
  revalidatePath('/');
}

/**
 * Storage lifecycle Option C (v1.1) — operator-triggered hard delete of a
 * source's on-disk video, freeing space while keeping all Postgres history
 * (assets, dispatches, signals). Removes the local media directory
 * (MEDIA_ROOT-guarded) AND the archived copy if present, then nulls
 * `local_media_path` + `archive_path` so any future `clip_render` /
 * `reviveSource` fails with a clean "media deleted" error instead of an
 * ENOENT crash. Irreversible — the rendered/published outputs are the
 * canonical artifacts after this.
 */
export async function deleteSourceVideo(packageId: string): Promise<void> {
  const [joined] = await db
    .select({ pkg: packages, source: sources })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!joined) throw new Error(`deleteSourceVideo: ${packageId} not found`);
  const { source } = joined;

  // Remove the local media dir (guarded to MEDIA_ROOT).
  if (source.localMediaPath) {
    const safeLocal = resolveMediaPath(source.localMediaPath);
    if (safeLocal) await rm(safeLocal, { recursive: true, force: true });
  }
  // Remove the archived copy too (Option B), if any. archive_path lives
  // outside MEDIA_ROOT by design, so it's not subject to the MEDIA_ROOT
  // guard — but we only ever delete a path we set ourselves.
  if (source.archivePath) {
    await rm(source.archivePath, { recursive: true, force: true });
  }

  await db
    .update(sources)
    .set({ localMediaPath: null, archivePath: null })
    .where(eq(sources.id, source.id));

  revalidatePath(`/packages/${packageId}`);
  revalidatePath('/');
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
