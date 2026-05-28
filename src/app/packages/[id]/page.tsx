import { join } from 'node:path';
import {
  type ApprovalAsset,
  type GenericAsset,
  type ShortClipRow,
  StudioShell,
} from '@/components/studio/StudioShell';
import { db } from '@/db/client';
import { assets, brands, experiments, packages, sources } from '@/db/schema';
import type { ExperimentVariant } from '@/db/schema/experiments';
import { readScoredList } from '@/lib/asset-payload';
import { mediaUrlFor } from '@/lib/media-path';
import {
  formatDuration,
  pipelineDetails,
  pipelineProgress,
  pipelineReadyToGenerate,
} from '@/lib/pipeline';
import { youtubeConnectionStatus } from '@workers/integrations/youtube';
import { networkFor } from '@workers/integrations/zernio';
import { asc, eq } from 'drizzle-orm';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ id: string }> };

const TABS = [
  { key: 'youtube', label: 'YouTube', icon: '▶' },
  { key: 'shorts', label: 'Shorts', icon: '✂' },
  { key: 'clips', label: 'Clips', icon: '▦' },
  { key: 'blog', label: 'Blog', icon: '📄' },
  { key: 'x', label: 'X', icon: '𝕏' },
  { key: 'linkedin', label: 'LinkedIn', icon: 'in' },
  { key: 'instagram', label: 'Instagram', icon: '◎' },
  { key: 'facebook', label: 'Facebook', icon: 'f' },
  { key: 'tiktok', label: 'TikTok', icon: '♪' },
  { key: 'threads', label: 'Threads', icon: '@' },
  { key: 'pinterest', label: 'Pinterest', icon: 'P' },
  { key: 'reddit', label: 'Reddit', icon: 'r' },
  { key: 'bluesky', label: 'Bluesky', icon: '☁' },
  { key: 'telegram', label: 'Telegram', icon: '✈' },
  { key: 'snapchat', label: 'Snapchat', icon: '👻' },
  { key: 'google_business', label: 'Google Business', icon: '⌂' },
  { key: 'whatsapp', label: 'WhatsApp', icon: '✆' },
  { key: 'discord', label: 'Discord', icon: '🎮' },
];

const TAB_ASSET_TYPES: Record<string, string[]> = {
  shorts: ['short_clip_plan', 'rendered_short_clip'],
  clips: ['rendered_short_clip', 'long_clip_plan', 'rendered_long_clip'],
  blog: ['article_brief', 'newsletter_summary'],
  x: ['x_post', 'x_thread'],
  linkedin: ['linkedin_post'],
};

const READY = new Set(['ready_for_review', 'approved', 'dispatched', 'published']);
const FAILED = new Set(['failed', 'rejected']);

function assetLabel(type: string): string {
  return type
    .replace(/_/g, ' ')
    .replace(/\byoutube\b/i, 'YouTube')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function PackageDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [joined] = await db
    .select({ pkg: packages, source: sources, brand: brands })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .innerJoin(brands, eq(brands.id, packages.brandId))
    .where(eq(packages.id, id))
    .limit(1);
  if (!joined) notFound();
  const { pkg, source, brand } = joined;

  const rows = await db
    .select()
    .from(assets)
    .where(eq(assets.packageId, id))
    .orderBy(asc(assets.type));
  const byType = (t: string) => rows.find((r) => r.type === t);
  const intelligence = pkg.intelligence as Record<string, unknown>;

  const ingest = (intelligence.ingest ?? {}) as { file_path?: string };
  const videoUrl =
    (ingest.file_path && mediaUrlFor(ingest.file_path)) ||
    (source.localMediaPath ? mediaUrlFor(join(source.localMediaPath, 'original.mp4')) : null);

  // Public YouTube URL the operator pasted after manually uploading (stored
  // on package.intelligence.published.youtube). null until they set it.
  const published = (intelligence.published ?? {}) as Record<string, unknown>;
  const ytRecord = (published.youtube ?? null) as { url?: string; video_id?: string } | null;
  const youtubeLive =
    ytRecord?.url && ytRecord.video_id ? { url: ytRecord.url, videoId: ytRecord.video_id } : null;

  // Per-package YouTube publish options (privacy + optional schedule).
  // Persisted on intelligence.publish_options.youtube via the picker.
  const publishOpts = (intelligence.publish_options ?? {}) as Record<string, unknown>;
  const ytOpts = (publishOpts.youtube ?? {}) as { privacy?: string; publish_at?: string };
  const ytPrivacy = (
    ytOpts.privacy && ['public', 'unlisted', 'private', 'schedule'].includes(ytOpts.privacy)
      ? ytOpts.privacy
      : 'private'
  ) as 'public' | 'unlisted' | 'private' | 'schedule';
  const youtubeDirect = {
    enabled:
      brand.youtubeDispatchTarget === 'youtube_direct' && !!brand.youtubeOauth?.refresh_token,
    privacy: ytPrivacy,
    publishAt: ytOpts.publish_at ?? null,
  };

  const transcript = ((intelligence.transcript ?? {}) as { text?: string }).text ?? '';

  // ─── Shorts collapsed view ─────────────────────────────────────────────
  // Replace the generic short_clip_plan + rendered_short_clip flat list
  // with one row per clip_index — each row carries the plan's editable
  // metadata (title/description/tags/styling/publish_options) PLUS the
  // rendered asset's id/url/duration when a render exists. The Studio's
  // ShortsList renders this directly; the per-clip editor route reads
  // the same shape.
  const shortPlans = rows.filter((r) => r.type === 'short_clip_plan');
  const renderedShorts = rows.filter((r) => r.type === 'rendered_short_clip');
  const shortsRows: ShortClipRow[] = [];
  for (const plan of shortPlans) {
    const planPayload = (plan.payload ?? {}) as { clips?: Record<string, unknown>[] };
    const planClips = Array.isArray(planPayload.clips) ? planPayload.clips : [];
    for (let i = 0; i < planClips.length; i++) {
      const planClip = planClips[i] as Record<string, unknown> | undefined;
      if (!planClip) continue;
      if (planClip.deleted === true) continue;
      const rendered = renderedShorts.find((rc) => {
        const p = rc.payload as { plan_asset_id?: string; clip_index?: number };
        return p.plan_asset_id === plan.id && p.clip_index === i;
      });
      const rp = rendered?.payload as
        | {
            local_path?: string;
            duration_seconds?: number;
            width?: number;
            height?: number;
          }
        | undefined;
      shortsRows.push({
        planAssetId: plan.id,
        clipIndex: i,
        plan: planClip,
        rendered: rendered
          ? {
              id: rendered.id,
              status: rendered.status,
              videoUrl: rp?.local_path ? mediaUrlFor(rp.local_path) : null,
              durationSeconds: rp?.duration_seconds ?? null,
              width: rp?.width ?? null,
              height: rp?.height ?? null,
            }
          : null,
      });
    }
  }

  const titlesAsset = byType('youtube_title_set');
  const titles = readScoredList((titlesAsset?.payload as { titles?: unknown })?.titles);
  const selectedIndex = Number(
    (titlesAsset?.payload as { selectedIndex?: number })?.selectedIndex ?? 0,
  );
  const descAsset = byType('youtube_description');
  const description = ((descAsset?.payload as { text?: string })?.text ?? '') as string;
  const tagsAsset = byType('youtube_tags');
  const tags = readScoredList((tagsAsset?.payload as { tags?: unknown })?.tags);

  const thumbnails = rows
    .filter((r) => r.type === 'thumbnail_concept')
    .map((r) => {
      const p = r.payload as { local_path?: string; hook_score?: number; rank?: number };
      return {
        id: r.id,
        url: p.local_path ? mediaUrlFor(p.local_path) : null,
        score: typeof p.hook_score === 'number' ? Math.round(p.hook_score * 100) : (p.rank ?? null),
      };
    });

  const selectedTitle =
    titles[Math.min(selectedIndex, Math.max(titles.length - 1, 0))]?.text ??
    source.title ??
    source.originUrl ??
    pkg.id;

  const metadataText = [
    `TITLE: ${selectedTitle}`,
    '',
    'DESCRIPTION:',
    description,
    '',
    `TAGS: ${tags.map((t) => t.text).join(', ')}`,
  ].join('\n');

  const assetsByTab: Record<string, GenericAsset[]> = {};
  for (const [tab, types] of Object.entries(TAB_ASSET_TYPES)) {
    assetsByTab[tab] = rows
      .filter((r) => types.includes(r.type))
      .map((r) => ({
        id: r.id,
        type: r.type,
        payload: r.payload as Record<string, unknown>,
        status: r.status,
      }));
  }

  const counts = {
    total: rows.length,
    ready: rows.filter((r) => READY.has(r.status)).length,
    pending: rows.filter((r) => !READY.has(r.status) && !FAILED.has(r.status)).length,
    failed: rows.filter((r) => FAILED.has(r.status)).length,
  };

  // Pre-compute per-asset "blocked" reasons so the panel can grey-out and
  // exclude un-publishable rows from the default selection. The publishAsset
  // server action also checks these, but doing it here turns a 500 into a
  // visible inline reason.
  const zernioAccounts = (brand.zernioAccounts ?? {}) as Record<string, string>;
  const hasDojoclaw = !!process.env.DOJOCLAW_API_KEY;
  const hasZernio = !!process.env.ZERNIO_API_KEY;
  function blockedReason(type: string): string | null {
    if (type.endsWith('_plan')) {
      return 'Plans aren’t dispatchable — render the clips first.';
    }
    if (type === 'article_brief' && !hasDojoclaw) {
      return 'Set DOJOCLAW_API_KEY in /settings before publishing briefs.';
    }
    // youtube_*, thumbnail_concept, newsletter_summary, transcript → manual; always OK
    if (
      type.startsWith('youtube_') ||
      type === 'thumbnail_concept' ||
      type === 'newsletter_summary' ||
      type === 'transcript' ||
      type === 'article_brief'
    ) {
      return null;
    }
    // Everything else is a Zernio (LATE) network type — needs API key + account.
    if (!hasZernio) return 'Set ZERNIO_API_KEY in /settings before publishing socials.';
    const platformKey = networkFor(type);
    if (!zernioAccounts[platformKey]) {
      return `No Zernio account for ${platformKey}. Connect one in Zernio + paste the acc_… on the brand page.`;
    }
    return null;
  }

  // ─── A/B experiments ──────────────────────────────────────────────────────
  // Detect whether this package has a published YouTube video id (same logic
  // the createExperiment server action uses, done here so the panel can show
  // the right empty/blocked state without a round-trip).
  let hasPublishedVideo = false;
  for (const r of rows) {
    const d = (r.dispatch ?? {}) as { video_id?: string; external_id?: string; target?: string };
    if (d.target === 'youtube_direct' && (d.video_id || d.external_id)) {
      hasPublishedVideo = true;
      break;
    }
  }
  if (!hasPublishedVideo) {
    const ytVid = (intelligence.youtube as { video_id?: string } | undefined)?.video_id;
    if (ytVid) hasPublishedVideo = true;
  }

  // Analytics scope — needed to auto-decide winner after rotation.
  const ytStatus = await youtubeConnectionStatus(brand.id);
  const analyticsGranted = ytStatus.analytics;

  // Load existing experiments for this package.
  const expRows = await db
    .select()
    .from(experiments)
    .where(eq(experiments.packageId, id))
    .orderBy(asc(experiments.createdAt));

  // Build title options from the already-loaded title asset.
  const experimentTitleOptions = titles.map((t, i) => ({
    index: i,
    text: t.text,
    score: t.score,
  }));

  // Build thumbnail options from the already-loaded thumbnail_concept assets.
  const experimentThumbnailOptions = rows
    .filter((r) => r.type === 'thumbnail_concept')
    .map((r) => {
      const p = r.payload as {
        local_path?: string;
        variant?: string;
        headline?: string;
        rank?: number;
      };
      return {
        assetId: r.id,
        mediaUrl: p.local_path ? mediaUrlFor(p.local_path) : null,
        variant: (p.variant as 'plain' | 'headline' | 'frame') ?? 'frame',
        headline: p.headline ?? null,
        rank: typeof p.rank === 'number' ? p.rank : null,
        localPath: p.local_path ?? null,
      };
    });

  // Shape experiment rows for the panel — pick only the fields the component needs.
  const experimentRows = expRows.map((e) => ({
    id: e.id,
    kind: e.kind,
    status: e.status,
    metric: e.metric,
    videoId: e.videoId,
    rotationHours: e.rotationHours,
    rounds: e.rounds,
    minViews: e.minViews,
    currentVariant: e.currentVariant,
    currentCycle: e.currentCycle,
    winnerVariant: e.winnerVariant,
    lastError: e.lastError,
    startedAt: e.startedAt ? e.startedAt.toISOString() : null,
    decidedAt: e.decidedAt ? e.decidedAt.toISOString() : null,
    createdAt: e.createdAt.toISOString(),
    variants: (e.variants ?? []) as ExperimentVariant[],
  }));

  // Bundling: when youtube_direct is active for this brand, the title_set's
  // upload sweeps description/chapters/tags into the same YouTube video. The
  // panel hides those rows and shows them under the title_set's "bundles:"
  // subtitle so the operator isn't asked to dispatch them separately.
  const directConnected =
    brand.youtubeDispatchTarget === 'youtube_direct' && !!brand.youtubeOauth?.refresh_token;
  const titleSetRow = rows.find((r) => r.type === 'youtube_title_set');
  const bundledIntoTitleSet = new Set<string>(
    directConnected && titleSetRow
      ? rows
          .filter(
            (r) =>
              r.type === 'youtube_description' ||
              r.type === 'youtube_chapters' ||
              r.type === 'youtube_tags',
          )
          .map((r) => r.id)
      : [],
  );

  const approval: ApprovalAsset[] = rows.map((r) => {
    const text = (r.payload as { text?: string }).text;
    const disp = (r.dispatch ?? {}) as { error?: string };
    return {
      id: r.id,
      label: assetLabel(r.type),
      sub: text ? `${text.slice(0, 48)}${text.length > 48 ? '…' : ''}` : r.type,
      status: r.status,
      type: r.type,
      blocked: blockedReason(r.type),
      dispatchError: r.status === 'failed' && disp.error ? disp.error : null,
      bundledInto: bundledIntoTitleSet.has(r.id) ? (titleSetRow?.id ?? null) : null,
    };
  });

  return (
    <StudioShell
      packageId={pkg.id}
      sourceId={source.id}
      pkg={{
        status: pkg.status,
        profile: pkg.processingProfile,
        updatedAt: new Date(pkg.updatedAt).toISOString().slice(0, 16).replace('T', ' '),
        duration: formatDuration(source.durationSeconds),
      }}
      brand={{ slug: brand.slug, name: brand.name }}
      videoUrl={videoUrl}
      metadataText={metadataText}
      progress={pipelineProgress(intelligence, pkg.status)}
      pipelineDetails={pipelineDetails(
        intelligence,
        pkg.status,
        pipelineProgress(intelligence, pkg.status),
      )}
      analysisReady={pipelineReadyToGenerate(intelligence)}
      counts={counts}
      youtube={{
        titlesAssetId: titlesAsset?.id ?? null,
        titles,
        selectedIndex,
        descriptionAssetId: descAsset?.id ?? null,
        description,
        tagsAssetId: tagsAsset?.id ?? null,
        tags,
        transcript,
        thumbnails,
      }}
      tabs={TABS}
      assetsByTab={assetsByTab}
      approval={approval}
      youtubeLive={youtubeLive}
      youtubeDirect={youtubeDirect}
      shorts={shortsRows}
      experiments={{
        rows: experimentRows,
        hasPublishedVideo,
        analyticsGranted,
        titleOptions: experimentTitleOptions,
        thumbnailOptions: experimentThumbnailOptions,
      }}
    />
  );
}
