'use client';

import type { ScoredItem } from '@/lib/asset-payload';
import { publishAsset } from '@/server-actions/publish';
import { regenerateAsset } from '@/server-actions/regenerate';
import { useState } from 'react';
import { DescriptionCard } from './DescriptionCard';
import { SectionCard } from './SectionCard';
import { TagsCard } from './TagsCard';
import { ThumbnailStrip } from './ThumbnailStrip';
import { TitlesCard } from './TitlesCard';
import { TranscriptCard } from './TranscriptCard';
import { VideoPlayer } from './VideoPlayer';
import { AsyncActionButton, CopyButton } from './buttons';

export type GenericAsset = { id: string; type: string; payload: Record<string, unknown> };

export type StudioProps = {
  packageId: string;
  sourceId: string;
  videoUrl: string | null;
  metadataText: string;
  youtube: {
    titlesAssetId: string | null;
    titles: ScoredItem[];
    selectedIndex: number;
    descriptionAssetId: string | null;
    description: string;
    tagsAssetId: string | null;
    tags: ScoredItem[];
    transcript: string;
    thumbnails: { id: string; url: string | null; score: number | null }[];
  };
  tabs: { key: string; label: string; icon: string }[];
  assetsByTab: Record<string, GenericAsset[]>;
};

export function Studio(props: StudioProps) {
  const [active, setActive] = useState('youtube');

  return (
    <div>
      {/* Platform pill bar — horizontally scrollable */}
      <div className="mb-6 overflow-x-auto">
        <div className="inline-flex gap-1 rounded-xl bg-zinc-100 p-1 dark:bg-zinc-900">
          {props.tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setActive(t.key)}
              className={`whitespace-nowrap rounded-lg px-4 py-2 text-sm font-medium transition ${
                active === t.key
                  ? 'bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-white'
                  : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200'
              }`}
            >
              <span className="mr-1.5" aria-hidden>
                {t.icon}
              </span>
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {active === 'youtube' ? (
        <YouTubeTab {...props} />
      ) : (
        <GenericTab assets={props.assetsByTab[active] ?? []} label={labelFor(props.tabs, active)} />
      )}
    </div>
  );
}

function labelFor(tabs: { key: string; label: string }[], key: string): string {
  return tabs.find((t) => t.key === key)?.label ?? key;
}

function YouTubeTab(props: StudioProps) {
  const { youtube: y } = props;
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {props.videoUrl && (
          <a
            href={props.videoUrl}
            download
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
          >
            ⤓ Download Video
          </a>
        )}
        <DownloadMetadataButton text={props.metadataText} />
        {y.descriptionAssetId && (
          <AsyncActionButton
            action={() => publishAsset(y.descriptionAssetId as string)}
            variant="primary"
            icon="➤"
            pendingLabel="Publishing…"
          >
            Publish to YouTube
          </AsyncActionButton>
        )}
      </div>

      <VideoPlayer src={props.videoUrl} />

      <ThumbnailStrip
        packageId={props.packageId}
        sourceId={props.sourceId}
        thumbnails={y.thumbnails}
      />

      <TitlesCard assetId={y.titlesAssetId} titles={y.titles} selectedIndex={y.selectedIndex} />
      <DescriptionCard assetId={y.descriptionAssetId} text={y.description} />
      <TagsCard assetId={y.tagsAssetId} tags={y.tags} />
      <TranscriptCard text={y.transcript} />
    </div>
  );
}

function GenericTab({ assets, label }: { assets: GenericAsset[]; label: string }) {
  if (assets.length === 0) {
    return (
      <SectionCard title={label} icon="•">
        <p className="text-sm text-zinc-500">
          No {label} assets yet. They're produced by the pipeline; this tab will fill in as the
          package finishes processing. (Net-new per-platform generators land in a later pass.)
        </p>
      </SectionCard>
    );
  }
  return (
    <div className="space-y-4">
      {assets.map((a) => (
        <SectionCard
          key={a.id}
          title={a.type}
          ready
          actions={
            <>
              <CopyButton text={JSON.stringify(a.payload, null, 2)} label="Copy" />
              <AsyncActionButton
                action={() => regenerateAsset(a.id)}
                icon="↻"
                pendingLabel="Regenerating…"
              >
                Regenerate
              </AsyncActionButton>
              <AsyncActionButton
                action={() => publishAsset(a.id)}
                variant="primary"
                icon="➤"
                pendingLabel="Publishing…"
              >
                Publish
              </AsyncActionButton>
            </>
          }
        >
          <pre className="max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-zinc-50 p-3 text-xs leading-relaxed dark:bg-zinc-950">
            {JSON.stringify(a.payload, null, 2)}
          </pre>
        </SectionCard>
      ))}
    </div>
  );
}

function DownloadMetadataButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'youtube-metadata.txt';
        a.click();
        URL.revokeObjectURL(url);
      }}
      className="inline-flex items-center gap-1.5 rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      ⤓ Download YouTube Metadata
    </button>
  );
}
