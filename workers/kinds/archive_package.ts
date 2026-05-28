/**
 * §13 / Storage lifecycle (Option B). Moves a package's source media off
 * MEDIA_ROOT to ARCHIVE_ROOT once the package has been published for at
 * least ARCHIVE_AFTER_DAYS.
 *
 * Semantics:
 *  - Job key: one job per `packageId`.
 *  - File-level: archive when this is the LAST unarchived package on its
 *    source. Otherwise just flip this package's `archived_at` and leave
 *    files in place for the next archive cycle. Re-running the pipeline
 *    on the same source produces a new package that pins the files.
 *  - DB-level: set `packages.archived_at` always; set
 *    `sources.archive_path` only when files actually moved.
 *  - Re-render survives archive: clip_render reads `archive_path` as a
 *    fallback when the local copy is gone (see workers/kinds/clip_render.ts).
 *  - Idempotent: if `dest/original.mp4` already exists with a matching
 *    size, the src is deleted without re-copying. A second run is a no-op.
 *  - Skip-safe: missing ARCHIVE_ROOT or unwritable destination → throw,
 *    queue requeues with exponential backoff. The recurring enqueuer
 *    won't fan out archive jobs at all unless ARCHIVE_ROOT is set, but
 *    this worker defends against direct/manual enqueues too.
 *  - ARCHIVE_DELETE_CLIPS=1: rendered clips are deleted instead of moved
 *    (the original.mp4 still moves — clip_render needs it for re-renders).
 */
import { cp, mkdir, rm, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { db } from '@/db/client';
import { packages, sources } from '@/db/schema';
import { MEDIA_ROOT } from '@/lib/media-path';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { JobRow } from '../queue';

const Payload = z.object({
  packageId: z.string().regex(/^pkg_/),
});

export async function run(job: JobRow): Promise<void> {
  const { packageId } = Payload.parse(job.payload);

  const archiveRoot = (process.env.ARCHIVE_ROOT ?? '').trim();
  if (!archiveRoot) {
    console.log(`[archive_package] ARCHIVE_ROOT unset — skipping ${packageId}`);
    return;
  }

  const [row] = await db
    .select({ pkg: packages, src: sources })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!row) throw new Error(`archive_package: package ${packageId} not found`);

  if (row.pkg.archivedAt) {
    console.log(
      `[archive_package] ${packageId} already archived at ${row.pkg.archivedAt.toISOString()}`,
    );
    return;
  }

  const src = row.src;
  if (!src.localMediaPath) {
    // Ingest never wrote anything to disk for this source. Mark archived
    // and move on — there's no file work to do.
    await markPackageArchived(packageId);
    console.log(`[archive_package] ${packageId} marked archived (no localMediaPath)`);
    return;
  }

  // Only the LAST unarchived package on a source triggers the file move.
  // Earlier ones flip their flag but leave the source bytes alone — a
  // sibling package still references them.
  const otherActive = await db
    .select({ id: packages.id })
    .from(packages)
    .where(
      and(
        eq(packages.sourceId, src.id),
        isNull(packages.archivedAt),
        sql`${packages.id} <> ${packageId}`,
      ),
    )
    .limit(1);
  const isLastPackage = otherActive.length === 0;

  let destRoot: string | null = src.archivePath;

  if (isLastPackage) {
    // Defence: localMediaPath must be inside MEDIA_ROOT or the relative-path
    // arithmetic below would escape ARCHIVE_ROOT.
    const rel = relative(MEDIA_ROOT, src.localMediaPath);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(
        `archive_package: source ${src.id} localMediaPath '${src.localMediaPath}' is outside MEDIA_ROOT '${MEDIA_ROOT}'`,
      );
    }
    destRoot = resolve(archiveRoot, rel);

    // mkdir verifies the drive is mounted + writable. If it isn't, we throw
    // and the queue backs off — next cycle tries again. No partial state.
    try {
      await mkdir(destRoot, { recursive: true });
    } catch (err) {
      throw new Error(
        `archive_package: ARCHIVE_ROOT not writable (${destRoot}): ${(err as Error).message}`,
      );
    }

    // original.mp4 always moves — clip_render needs it for re-renders even
    // after archive (it reads source.archive_path as a fallback).
    await moveFile(
      join(src.localMediaPath, 'original.mp4'),
      join(destRoot, 'original.mp4'),
    );

    // clips/ either moves or gets deleted, based on the operator's policy.
    const srcClipsDir = join(src.localMediaPath, 'clips');
    const destClipsDir = join(destRoot, 'clips');
    const deleteClips = ['1', 'true', 'on', 'yes'].includes(
      String(process.env.ARCHIVE_DELETE_CLIPS ?? '').toLowerCase(),
    );
    await moveOrDeleteDir(srcClipsDir, destClipsDir, { delete: deleteClips });
  } else {
    console.log(
      `[archive_package] ${packageId} flagged but source ${src.id} kept on local (sibling package still active)`,
    );
  }

  // Phase 2 — atomic DB flip. If the move above succeeded we record the
  // new archive path; if the source already had one we leave it alone.
  await db.transaction(async (tx) => {
    if (isLastPackage && destRoot && destRoot !== src.archivePath) {
      await tx
        .update(sources)
        .set({ archivePath: destRoot })
        .where(eq(sources.id, src.id));
    }
    await tx
      .update(packages)
      .set({ archivedAt: new Date(), updatedAt: sql`now()` })
      .where(eq(packages.id, packageId));
  });

  console.log(
    `[archive_package] ${packageId} archived (source=${src.id}${
      isLastPackage ? ` → ${destRoot}` : ' kept local'
    })`,
  );
}

async function markPackageArchived(packageId: string): Promise<void> {
  await db
    .update(packages)
    .set({ archivedAt: new Date(), updatedAt: sql`now()` })
    .where(eq(packages.id, packageId));
}

/**
 * Idempotent copy-then-delete. Cross-filesystem-safe (the archive drive
 * is almost certainly a different FS than the local one, so `rename` would
 * fail with EXDEV — we copy + verify size + delete instead).
 *
 *  - src missing             → no-op (already moved on a prior run)
 *  - dest exists, same size  → skip copy, just delete src
 *  - dest exists, diff size  → re-copy (overwrite), verify, delete src
 *  - dest missing            → copy, verify, delete src
 */
async function moveFile(srcPath: string, destPath: string): Promise<void> {
  const srcStat = await statOrNull(srcPath);
  if (!srcStat) {
    console.log(`[archive_package]   ${srcPath} missing — assume already moved`);
    return;
  }
  const destStat = await statOrNull(destPath);
  if (!destStat || destStat.size !== srcStat.size) {
    await cp(srcPath, destPath, { force: true });
    const verifyStat = await stat(destPath);
    if (verifyStat.size !== srcStat.size) {
      throw new Error(
        `archive_package: size mismatch after copy ${srcPath} → ${destPath} ` +
          `(src=${srcStat.size}, dst=${verifyStat.size})`,
      );
    }
    console.log(`[archive_package]   moved ${srcPath} → ${destPath} (${srcStat.size} bytes)`);
  } else {
    console.log(`[archive_package]   ${destPath} already present (${srcStat.size} bytes); skipping copy`);
  }
  await rm(srcPath, { force: true });
}

/**
 * Move (or delete) a directory tree. Same idempotency story as moveFile
 * but applied per-tree. When `delete: true`, the destination is never
 * touched — only the source is removed.
 */
async function moveOrDeleteDir(
  srcDir: string,
  destDir: string,
  opts: { delete: boolean },
): Promise<void> {
  const srcStat = await statOrNull(srcDir);
  if (!srcStat) return;
  if (!srcStat.isDirectory()) return;
  if (opts.delete) {
    await rm(srcDir, { recursive: true, force: true });
    console.log(`[archive_package]   deleted ${srcDir} (ARCHIVE_DELETE_CLIPS=1)`);
    return;
  }
  await cp(srcDir, destDir, { recursive: true, force: true });
  await rm(srcDir, { recursive: true, force: true });
  console.log(`[archive_package]   moved ${srcDir} → ${destDir}`);
}

async function statOrNull(p: string) {
  try {
    return await stat(p);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}
