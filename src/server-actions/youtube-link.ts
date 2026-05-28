'use server';

import { db } from '@/db/client';
import { assets, packages } from '@/db/schema';
import { parseYoutubeUrl } from '@/lib/youtube-url';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

/**
 * Operator records the public YouTube URL of the manually-uploaded video.
 * Persists on `packages.intelligence.published.youtube` so it survives
 * across reloads and shows on the package header as a clickable pill.
 *
 * Side effect: also marks the package's `youtube_title_set` asset (if any)
 * as `published` with the same URL in its `dispatch` field — that's the
 * canonical "this is live on YouTube" signal the dispatch lifecycle reads.
 */
export async function setPackageYoutubeUrl(
  packageId: string,
  rawUrl: string,
): Promise<{ url: string; videoId: string }> {
  if (!packageId.startsWith('pkg_')) throw new Error('invalid packageId');
  const ref = parseYoutubeUrl(rawUrl);
  if (!ref) {
    throw new Error(
      'Not a recognised YouTube URL. Paste a youtu.be/… or youtube.com/watch?v=… link.',
    );
  }

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`setPackageYoutubeUrl: package ${packageId} not found`);

  const intelligence = {
    ...((pkg.intelligence as Record<string, unknown>) ?? {}),
    published: {
      ...(((pkg.intelligence as Record<string, unknown>)?.published ?? {}) as Record<
        string,
        unknown
      >),
      youtube: {
        url: ref.url,
        video_id: ref.videoId,
        set_at: new Date().toISOString(),
      },
    },
  };
  await db.update(packages).set({ intelligence }).where(eq(packages.id, packageId));

  // Best-effort: flip the package's youtube_title_set to `published` and
  // record the URL in its dispatch JSONB. Idempotent — does nothing if the
  // asset isn't present (e.g. a podcast-only package). We only flip from
  // `dispatched` onward; never overwrite an external URL we already have.
  const [titleAsset] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.packageId, packageId), eq(assets.type, 'youtube_title_set')))
    .limit(1);
  if (titleAsset && titleAsset.status === 'dispatched') {
    const dispatch = {
      ...(((titleAsset.dispatch as Record<string, unknown>) ?? {}) as Record<string, unknown>),
      target: 'manual',
      external_url: ref.url,
      external_id: ref.videoId,
      published_at: new Date().toISOString(),
    };
    await db
      .update(assets)
      .set({ status: 'published', dispatch, updatedAt: sql`now()` })
      .where(eq(assets.id, titleAsset.id));
  }

  revalidatePath(`/packages/${packageId}`);
  return ref;
}

/**
 * Clear the recorded URL — useful if the operator pasted a wrong link or the
 * video was unlisted/deleted. Leaves asset/package status alone (a row that
 * went to `published` stays `published`; un-publish is out of scope for v1).
 */
export async function clearPackageYoutubeUrl(packageId: string): Promise<void> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`clearPackageYoutubeUrl: package ${packageId} not found`);
  const intel = (pkg.intelligence ?? {}) as Record<string, unknown>;
  const pub = (intel.published ?? {}) as Record<string, unknown>;
  if (!pub.youtube) return; // already empty
  const { youtube: _drop, ...restPub } = pub;
  const next = { ...intel, published: restPub };
  await db.update(packages).set({ intelligence: next }).where(eq(packages.id, packageId));
  revalidatePath(`/packages/${packageId}`);
}
