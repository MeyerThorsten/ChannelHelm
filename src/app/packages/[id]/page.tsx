import { join } from 'node:path';
import { StatusPill } from '@/components/StatusPill';
import { type GenericAsset, Studio } from '@/components/studio/Studio';
import { AsyncActionButton } from '@/components/studio/buttons';
import { db } from '@/db/client';
import { assets, brands, packages, sources } from '@/db/schema';
import { readScoredList } from '@/lib/asset-payload';
import { mediaUrlFor } from '@/lib/media-path';
import { deletePackage, retryPackage } from '@/server-actions/studio';
import { asc, eq } from 'drizzle-orm';
import Link from 'next/link';
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

  // Video URL: prefer the ingest-recorded path, else original.mp4 in the dir.
  const ingest = (intelligence.ingest ?? {}) as { file_path?: string };
  const videoUrl =
    (ingest.file_path && mediaUrlFor(ingest.file_path)) ||
    (source.localMediaPath ? mediaUrlFor(join(source.localMediaPath, 'original.mp4')) : null);

  const transcript = ((intelligence.transcript ?? {}) as { text?: string }).text ?? '';

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
      .map((r) => ({ id: r.id, type: r.type, payload: r.payload as Record<string, unknown> }));
  }

  const retry = retryPackage.bind(null, pkg.id);
  const del = deletePackage.bind(null, pkg.id);

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-2">
        <Link href="/" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
          ← all packages
        </Link>
      </div>
      <header className="mb-6 flex items-start justify-between gap-4 border-b border-zinc-200 pb-5 dark:border-zinc-800">
        <div className="min-w-0">
          <h1 className="truncate text-3xl font-bold tracking-tight">{selectedTitle}</h1>
          <div className="mt-2 flex items-center gap-3 text-sm text-zinc-500">
            <span className="font-medium text-zinc-700 dark:text-zinc-300">{brand.slug}</span>
            <span>·</span>
            <span>{pkg.processingProfile}</span>
            <span>·</span>
            <StatusPill status={pkg.status} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <AsyncActionButton action={retry} icon="↺" pendingLabel="Retrying…">
            Retry
          </AsyncActionButton>
          <AsyncActionButton action={del} variant="danger" icon="🗑" pendingLabel="Deleting…">
            Delete
          </AsyncActionButton>
        </div>
      </header>

      <Studio
        packageId={pkg.id}
        sourceId={source.id}
        videoUrl={videoUrl}
        metadataText={metadataText}
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
      />
    </main>
  );
}
