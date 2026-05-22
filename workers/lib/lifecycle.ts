import { db } from '@/db/client';
import { assets, jobs, packages } from '@/db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';

/**
 * §10 package lifecycle orchestration. Workers call these after their
 * milestones so `packages.status` reflects real progress for the dashboard
 * and operator workflow.
 */

const ORDER: Record<string, number> = {
  draft: 0,
  ingested: 1,
  transcribing: 2,
  analyzing_visual: 2,
  fused: 3,
  analyzed: 4,
  ready_for_review: 5,
  approved: 6,
  dispatching: 7,
  dispatched: 8,
  partially_dispatched: 8,
  failed: 9,
};
const READY_RANK = 5; // ORDER.ready_for_review
const rank = (status: string): number => ORDER[status] ?? 0;

/** Set the package status. */
export async function setPackageStatus(packageId: string, status: string): Promise<void> {
  await db
    .update(packages)
    .set({ status, updatedAt: sql`now()` })
    .where(eq(packages.id, packageId));
}

/**
 * Advance the package to `status` only if it represents forward progress and
 * the package isn't already past review/approval (so a late visual job can't
 * drag an approved package back to `analyzing_visual`). `failed` is never set
 * here — it's terminal and set explicitly on hard errors.
 */
export async function advancePackageStatus(packageId: string, status: string): Promise<void> {
  const [pkg] = await db
    .select({ status: packages.status })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg) return;
  const cur = rank(pkg.status);
  const next = rank(status);
  // Don't move backwards, and don't disturb a package already in/after review.
  if (next <= cur || cur >= READY_RANK) return;
  await setPackageStatus(packageId, status);
}

/**
 * After asset generation: if no generate_asset / clip_render jobs remain
 * pending or running for the package, mark it ready_for_review (from analyzed).
 */
export async function markReadyForReviewIfComplete(packageId: string): Promise<void> {
  const [pkg] = await db
    .select({ status: packages.status })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkg) return;
  if (rank(pkg.status) >= READY_RANK) return;

  const [outstanding] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(jobs)
    .where(
      and(
        inArray(jobs.kind, ['generate_asset', 'clip_render']),
        inArray(jobs.status, ['pending', 'running']),
        sql`${jobs.payload}->>'packageId' = ${packageId}`,
      ),
    );
  if ((outstanding?.n ?? 0) === 0) {
    await setPackageStatus(packageId, 'ready_for_review');
  }
}

/**
 * After a dispatch outcome: recompute the package's final dispatch state from
 * its dispatchable (non-plan) assets.
 *   - any approved-but-not-yet-dispatched → dispatching
 *   - all terminal & none failed          → dispatched
 *   - some succeeded, some failed          → partially_dispatched
 *   - all failed                           → failed
 */
export async function recomputePackageDispatchState(packageId: string): Promise<void> {
  const rows = await db
    .select({ type: assets.type, status: assets.status })
    .from(assets)
    .where(eq(assets.packageId, packageId));
  const dispatchable = rows.filter(
    (r) =>
      !r.type.endsWith('_plan') &&
      ['approved', 'dispatched', 'published', 'failed'].includes(r.status),
  );
  if (dispatchable.length === 0) return;

  const awaiting = dispatchable.filter((r) => r.status === 'approved').length;
  const succeeded = dispatchable.filter(
    (r) => r.status === 'dispatched' || r.status === 'published',
  ).length;
  const failed = dispatchable.filter((r) => r.status === 'failed').length;

  let next: string;
  if (awaiting > 0) next = 'dispatching';
  else if (failed === 0) next = 'dispatched';
  else if (succeeded > 0) next = 'partially_dispatched';
  else next = 'failed';

  await setPackageStatus(packageId, next);
}
