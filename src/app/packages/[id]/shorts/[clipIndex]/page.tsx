/**
 * Per-Short editor route.
 *
 * Server component — loads the plan asset, locates the target clip,
 * loads the rendered asset (if any), extracts word-level transcript
 * timings, and renders the interactive `<ShortsEditor>` client shell.
 *
 * URL shape: /packages/[id]/shorts/[clipIndex]
 *   id        — package id
 *   clipIndex — 0-based index into short_clip_plan.payload.clips[]
 *
 * Using clipIndex (not asset id) keeps the URL stable across re-renders
 * (a re-render produces a fresh rendered_short_clip row with a new id;
 * the URL must survive that).
 */

import { ShortsEditor } from '@/components/studio/shorts/ShortsEditor';
import { db } from '@/db/client';
import { assets, packages, sources } from '@/db/schema';
import { mediaUrlFor } from '@/lib/media-path';
import { flattenTranscriptWords } from '@/lib/word-snap';
import { and, eq, sql } from 'drizzle-orm';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Params = Promise<{ id: string; clipIndex: string }>;

export default async function ShortEditorPage({ params }: { params: Params }) {
  const { id: packageId, clipIndex: clipIndexStr } = await params;
  const clipIndex = Number.parseInt(clipIndexStr, 10);
  if (!Number.isInteger(clipIndex) || clipIndex < 0) notFound();

  // Load the package + source + plan asset in one round trip.
  const [pkgRow] = await db
    .select({ pkg: packages, source: sources })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(packages.id, packageId))
    .limit(1);
  if (!pkgRow) notFound();
  const { pkg, source } = pkgRow;

  // Find the short_clip_plan asset on this package. (One per package today.)
  const [plan] = await db
    .select()
    .from(assets)
    .where(and(eq(assets.packageId, packageId), eq(assets.type, 'short_clip_plan')))
    .limit(1);
  if (!plan) notFound();

  const planPayload = (plan.payload ?? {}) as { clips?: Record<string, unknown>[] };
  const clip = planPayload.clips?.[clipIndex];
  if (!clip) notFound();
  if (clip.deleted === true) notFound();

  // Try to find a corresponding rendered_short_clip row.
  const [rendered] = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.packageId, packageId),
        eq(assets.type, 'rendered_short_clip'),
        sql`(${assets.payload} ->> 'plan_asset_id') = ${plan.id}`,
        sql`(${assets.payload} ->> 'clip_index')::int = ${clipIndex}`,
      ),
    )
    .limit(1);

  // Extract word-level transcript timings (the data the editor needs for
  // word-snap + transcript panel). May be empty when the package ran
  // under fast_audio_only without word_timestamps.
  const intelligence = (pkg.intelligence ?? {}) as { transcript?: unknown };
  const words = flattenTranscriptWords(intelligence.transcript ?? {});

  // Source video URL — prefer the rendered file for the preview when
  // it's available, falling back to the source MP4. The editor swaps
  // between them via a prop on PreviewPlayer.
  const sourceVideoUrl = source.localMediaPath
    ? mediaUrlFor(`${source.localMediaPath}/original.mp4`)
    : '';
  const renderedLocalPath = (rendered?.payload as { local_path?: string } | undefined)?.local_path;
  const renderedVideoUrl = renderedLocalPath ? mediaUrlFor(renderedLocalPath) : null;

  // Long-form companion link for the Short's description ("Watch the full
  // video: …"). v1 uses source.origin_url when it's a YouTube URL. Future
  // iteration: prefer the published youtube_direct_upload asset's
  // public_url when one exists.
  const defaultDescriptionLink =
    source.originUrl && isYouTubeUrl(source.originUrl)
      ? { label: 'Watch the full video', url: source.originUrl }
      : null;

  return (
    <ShortsEditor
      packageId={packageId}
      packageTitle={source.title ?? source.originUrl ?? pkg.id}
      planAssetId={plan.id}
      clipIndex={clipIndex}
      clip={clip}
      sourceVideoUrl={sourceVideoUrl ?? ''}
      sourceDuration={Number(source.durationSeconds ?? 0)}
      words={words}
      renderedAssetId={rendered?.id ?? null}
      renderedVideoUrl={renderedVideoUrl}
      renderedStatus={rendered?.status ?? null}
      defaultDescriptionLink={defaultDescriptionLink}
    />
  );
}

/** YouTube watch / youtu.be / shorts / live URL detector. Conservative — only
 *  matches what we'd actually want a Short's "watch the full video" link to
 *  point at. */
function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\.|^m\./, '');
    return host === 'youtube.com' || host === 'youtu.be';
  } catch {
    return false;
  }
}
