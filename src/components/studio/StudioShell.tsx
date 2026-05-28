'use client';

import {
  Avatar,
  Eyebrow,
  GhostBtn,
  MockThumb,
  Pipeline,
  type PipelineDetails,
  type PipelineProgress,
  PlatformIcon,
  PrimaryBtn,
  ScorePill,
  StatusPill,
} from '@/components/ui';
import type { ScoredItem } from '@/lib/asset-payload';
import { brandColor } from '@/lib/brand-color';
import { publishAsset } from '@/server-actions/publish';
import { generateSection, regenerateAsset, saveAssetPayload } from '@/server-actions/regenerate';
import {
  deletePackage,
  generateThumbnails,
  retryPackage,
  selectTitle,
} from '@/server-actions/studio';
import { useRouter } from 'next/navigation';
import { type ReactNode, useEffect, useState, useTransition } from 'react';
import { YoutubeLinkPill } from './YoutubeLinkPill';
import { YoutubePublishOptions } from './YoutubePublishOptions';
import { ShortsList } from './shorts/ShortsList';

export type GenericAsset = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status?: string;
};
export type ApprovalAsset = {
  id: string;
  label: string;
  sub: string;
  status: string;
  type: string;
  /** When set, the row is non-publishable for this reason — UI greys it out and excludes from default selection. */
  blocked: string | null;
  /** Worker-side failure reason (asset.dispatch.error) — surfaced on the failed row. */
  dispatchError: string | null;
  /**
   * If set, this asset will be auto-bundled into the upload of another asset
   * (its `id`) when that one dispatches. The panel hides bundled rows and
   * lists their labels under the parent's "Includes:" subtitle. Used by
   * youtube_direct: title_set's upload sweeps description/chapters/tags in.
   */
  bundledInto: string | null;
};

/**
 * Per-clip row for the Shorts tab. Collapses the `short_clip_plan`'s
 * editable per-clip metadata with the corresponding `rendered_short_clip`
 * asset (if a render exists). The Shorts list + editor read from this
 * shape — the rendered side is null while the worker is still rendering
 * or before the operator has clicked Render.
 */
export type ShortClipRow = {
  planAssetId: string;
  clipIndex: number;
  plan: Record<string, unknown>; // the plan.clips[clipIndex] object — typed loosely so the editor can edit any field
  rendered: {
    id: string;
    status: string;
    videoUrl: string | null;
    durationSeconds: number | null;
    width: number | null;
    height: number | null;
  } | null;
};

export type StudioData = {
  packageId: string;
  sourceId: string;
  pkg: { status: string; profile: string; updatedAt: string; duration: string };
  brand: { slug: string; name: string };
  videoUrl: string | null;
  metadataText: string;
  progress: PipelineProgress;
  pipelineDetails: PipelineDetails;
  /** True once intelligence.analysis exists — i.e. generate_asset jobs are firing or done. */
  analysisReady: boolean;
  counts: { ready: number; pending: number; failed: number; total: number };
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
  approval: ApprovalAsset[];
  /** Public YouTube URL captured after the operator manually uploads the video. */
  youtubeLive: { url: string; videoId: string } | null;
  /** Per-package YouTube publish options. Only meaningful when the brand uses youtube_direct. */
  youtubeDirect: {
    enabled: boolean;
    privacy: 'public' | 'unlisted' | 'private' | 'schedule';
    publishAt: string | null;
  };
  /** Per-clip rows for the Shorts tab. See ShortClipRow above. */
  shorts: ShortClipRow[];
};

const PLATFORM_GROUP: Record<string, 'video' | 'editorial' | 'social'> = {
  youtube: 'video',
  shorts: 'video',
  clips: 'video',
  blog: 'editorial',
};
function groupOf(key: string): 'video' | 'editorial' | 'social' {
  return PLATFORM_GROUP[key] ?? 'social';
}

type Layout = 'console' | 'editor' | 'atlas';

export function StudioShell(data: StudioData) {
  const [layout, setLayout] = useState<Layout>('console');
  const [activePlatform, setActivePlatform] = useState('youtube');

  const common = { data, activePlatform, setActivePlatform };
  return (
    <div>
      <LayoutSwitch layout={layout} setLayout={setLayout} />
      {layout === 'console' && <ConsoleLayout {...common} />}
      {layout === 'editor' && <EditorLayout {...common} />}
      {layout === 'atlas' && <AtlasLayout {...common} />}
    </div>
  );
}

function LayoutSwitch({ layout, setLayout }: { layout: Layout; setLayout: (l: Layout) => void }) {
  const opts: { id: Layout; label: string; glyph: string }[] = [
    { id: 'console', label: 'Console', glyph: '▤' },
    { id: 'editor', label: 'Editor', glyph: '⌗' },
    { id: 'atlas', label: 'Atlas', glyph: '▦' },
  ];
  return (
    <div
      style={{
        position: 'fixed',
        right: 16,
        bottom: 16,
        zIndex: 60,
        display: 'flex',
        gap: 2,
        padding: 3,
        background: 'var(--panel)',
        border: '1px solid var(--border-strong)',
        borderRadius: 8,
        boxShadow: '0 8px 24px rgba(0,0,0,0.35)',
      }}
    >
      {opts.map((o) => {
        const active = o.id === layout;
        return (
          <button
            key={o.id}
            type="button"
            onClick={() => setLayout(o.id)}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '5px 10px',
              fontSize: 11,
              fontWeight: 500,
              borderRadius: 6,
              border: 'none',
              cursor: 'pointer',
              color: active ? 'var(--text)' : 'var(--text-muted)',
              background: active ? 'var(--bg-hover)' : 'transparent',
            }}
          >
            <span style={{ color: active ? 'var(--accent)' : 'var(--text-faint)' }}>{o.glyph}</span>
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

// ── Console layout ─────────────────────────────────────────────────────────
function ConsoleLayout({
  data,
  activePlatform,
  setActivePlatform,
}: {
  data: StudioData;
  activePlatform: string;
  setActivePlatform: (p: string) => void;
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '228px 1fr 340px',
        minHeight: 'calc(100vh - 48px)',
      }}
    >
      <PlatformRail data={data} active={activePlatform} setActive={setActivePlatform} />
      <div
        style={{ borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}
      >
        <StudioHeader data={data} />
        <div style={{ padding: '0 24px 60px' }}>
          <div
            style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16, margin: '16px 0' }}
          >
            <VideoPlayer data={data} />
            <PipelinePanel data={data} />
          </div>
          {activePlatform === 'youtube' ? (
            <YoutubeStack data={data} />
          ) : activePlatform === 'shorts' ? (
            <ShortsList packageId={data.packageId} rows={data.shorts} />
          ) : (
            <PlatformAssets data={data} platform={activePlatform} />
          )}
        </div>
      </div>
      <ApprovalPanel data={data} />
    </div>
  );
}

function StudioHeader({ data }: { data: StudioData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const selected = data.youtube.titles[data.youtube.selectedIndex]?.text;
  const title =
    selected ?? data.metadataText.split('\n')[0]?.replace(/^TITLE:\s*/, '') ?? data.packageId;

  function downloadMeta() {
    const blob = new Blob([data.metadataText], { type: 'text/plain' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${data.packageId}-youtube.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  return (
    <div
      style={{
        position: 'sticky',
        top: 48,
        zIndex: 5,
        padding: '16px 24px 12px',
        background: 'color-mix(in oklab, var(--bg) 90%, transparent)',
        backdropFilter: 'blur(10px)',
        WebkitBackdropFilter: 'blur(10px)',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <button
          type="button"
          onClick={() => router.push('/')}
          style={{
            fontSize: 11,
            color: 'var(--text-muted)',
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          ← All packages
        </button>
        <span style={{ color: 'var(--text-faint)', fontSize: 10 }}>/</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          {data.packageId}
        </span>
        <span style={{ flex: 1 }} />
        <span style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          updated {data.pkg.updatedAt}
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h1
            className="serif"
            style={{
              fontSize: 26,
              fontWeight: 400,
              margin: 0,
              lineHeight: 1.15,
              letterSpacing: -0.3,
            }}
          >
            {title}
          </h1>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
              fontSize: 11,
              color: 'var(--text-muted)',
              flexWrap: 'wrap',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <Avatar
                glyph={data.brand.slug.slice(0, 2).toUpperCase()}
                color={brandColor(data.brand.slug)}
                size={18}
              />
              {data.brand.name}
            </span>
            <span style={{ color: 'var(--text-faint)' }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>
              {data.pkg.profile.replace(/_/g, ' ')}
            </span>
            <span style={{ color: 'var(--text-faint)' }}>·</span>
            <span style={{ fontFamily: 'var(--font-mono)' }}>{data.pkg.duration}</span>
            <span style={{ color: 'var(--text-faint)' }}>·</span>
            <StatusPill status={data.pkg.status} />
            <YoutubeLinkPill
              packageId={data.packageId}
              initialUrl={data.youtubeLive?.url ?? null}
              initialVideoId={data.youtubeLive?.videoId ?? null}
              showPasteAffordance={data.approval.some(
                (a) =>
                  a.type.startsWith('youtube_') &&
                  (a.status === 'dispatched' || a.status === 'published'),
              )}
            />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <GhostBtn size="sm" icon="⎘" onClick={downloadMeta}>
            Metadata
          </GhostBtn>
          <GhostBtn
            size="sm"
            icon="↺"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await retryPackage(data.packageId);
              })
            }
          >
            Retry
          </GhostBtn>
          <GhostBtn
            size="sm"
            icon="🗑"
            danger
            onClick={() =>
              start(async () => {
                try {
                  await deletePackage(data.packageId);
                } catch (e) {
                  if (!String(e).includes('NEXT_REDIRECT')) throw e;
                }
              })
            }
          >
            Delete
          </GhostBtn>
        </div>
      </div>
    </div>
  );
}

function PipelinePanel({ data }: { data: StudioData }) {
  const done = Object.values(data.progress).filter((v) => v >= 1).length;
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: 16,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 }}
      >
        <Eyebrow>Pipeline</Eyebrow>
        <span style={{ fontSize: 11, color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
          {done}/4 layers complete
        </span>
      </div>
      <Pipeline progress={data.progress} details={data.pipelineDetails} layout="col" />
      <div
        style={{
          marginTop: 4,
          paddingTop: 14,
          borderTop: '1px solid var(--border)',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 10,
        }}
      >
        <Stat
          label="Ready"
          value={data.counts.ready}
          total={data.counts.total}
          color="var(--status-published)"
        />
        <Stat label="Pending" value={data.counts.pending} color="var(--status-analyzing)" />
        <Stat label="Failed" value={data.counts.failed} color="var(--status-failed)" />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  total,
  color,
}: { label: string; value: number; total?: number; color: string }) {
  return (
    <div>
      <div
        style={{
          fontSize: 10,
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          letterSpacing: 0.06,
          marginBottom: 2,
        }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
        <span
          style={{
            fontSize: 20,
            fontWeight: 500,
            fontFamily: 'var(--font-mono)',
            color: value > 0 ? color : 'var(--text-dim)',
          }}
        >
          {value}
        </span>
        {total != null && (
          <span
            style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
          >
            / {total}
          </span>
        )}
      </div>
    </div>
  );
}

function PlatformRail({
  data,
  active,
  setActive,
}: { data: StudioData; active: string; setActive: (p: string) => void }) {
  const groups: { id: 'video' | 'editorial' | 'social'; label: string }[] = [
    { id: 'video', label: 'Video' },
    { id: 'editorial', label: 'Editorial' },
    {
      id: 'social',
      label: `Social · ${data.tabs.filter((t) => groupOf(t.key) === 'social').length}`,
    },
  ];
  return (
    <aside
      style={{
        background: 'var(--panel)',
        padding: '16px 8px',
        position: 'sticky',
        top: 48,
        alignSelf: 'start',
        maxHeight: 'calc(100vh - 48px)',
        overflow: 'auto',
      }}
    >
      {groups.map((g) => (
        <div key={g.id} style={{ marginBottom: 16 }}>
          <Eyebrow style={{ padding: '0 10px 6px' }}>{g.label}</Eyebrow>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            {data.tabs
              .filter((t) => groupOf(t.key) === g.id)
              .map((t) => {
                const isActive = t.key === active;
                const c = completionFor(data, t.key);
                return (
                  <button
                    key={t.key}
                    type="button"
                    onClick={() => setActive(t.key)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '6px 10px',
                      background: isActive ? 'var(--bg-hover)' : 'transparent',
                      border: 'none',
                      borderRadius: 6,
                      textAlign: 'left',
                      color: isActive ? 'var(--text)' : 'var(--text-muted)',
                      position: 'relative',
                      cursor: 'pointer',
                    }}
                  >
                    {isActive && (
                      <span
                        style={{
                          position: 'absolute',
                          left: -2,
                          top: 6,
                          bottom: 6,
                          width: 2,
                          background: 'var(--accent)',
                          borderRadius: 1,
                        }}
                      />
                    )}
                    <PlatformIcon platform={t.key} size={18} active={isActive} />
                    <span style={{ flex: 1, fontSize: 12, fontWeight: isActive ? 500 : 400 }}>
                      {t.label}
                    </span>
                    <CompletionDot value={c} />
                  </button>
                );
              })}
          </div>
        </div>
      ))}
    </aside>
  );
}

function completionFor(data: StudioData, key: string): number {
  if (key === 'youtube') {
    const y = data.youtube;
    const parts = [y.titlesAssetId, y.descriptionAssetId, y.tagsAssetId];
    const have = parts.filter(Boolean).length;
    return have === 0 ? 0 : have === parts.length ? 1 : 0.5;
  }
  const list = data.assetsByTab[key] ?? [];
  return list.length === 0 ? 0 : 1;
}

function CompletionDot({ value }: { value: number }) {
  const bg =
    value >= 1
      ? 'var(--status-published)'
      : value > 0
        ? 'var(--status-analyzing)'
        : 'var(--border-strong)';
  return (
    <span
      style={{
        width: 6,
        height: 6,
        borderRadius: 999,
        background: bg,
        animation: value > 0 && value < 1 ? 'pulse-soft 1.6s ease-in-out infinite' : 'none',
      }}
    />
  );
}

function ApprovalPanel({ data }: { data: StudioData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [published, setPublished] = useState<Set<string>>(new Set());
  const [rowErrors, setRowErrors] = useState<Record<string, string>>({});
  const [pollingFor, setPollingFor] = useState<Set<string>>(new Set());
  // "Ready" = available to dispatch right now (no blocked reason, no terminal
  // state, not bundled into another asset's upload).
  const ready = data.approval.filter(
    (a) =>
      !a.blocked &&
      !a.bundledInto &&
      (a.status === 'ready_for_review' || a.status === 'approved'),
  );
  const approvedCount = data.approval.filter(
    (a) => a.status === 'approved' || published.has(a.id),
  ).length;

  // Real selection state. Defaults to "every ready asset selected" so the
  // bottom button's previous default-everything behavior is preserved if you
  // just click it. Clicking a row TOGGLES (it no longer immediately publishes
  // — that was the bug behind "I can not deselect").
  const [selected, setSelected] = useState<Set<string>>(() => new Set(ready.map((a) => a.id)));
  // If the server-side list of ready assets changes (e.g. after a refresh),
  // sync the selection so newly-ready assets are picked up by default and
  // disappeared ones leave the set.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — sync only when ready ids change
  useEffect(() => {
    const readyIds = new Set(ready.map((a) => a.id));
    setSelected((prev) => {
      const next = new Set<string>();
      // Keep previously-selected ids that are still ready.
      for (const id of prev) if (readyIds.has(id)) next.add(id);
      // Add newly-ready assets as selected by default.
      for (const id of readyIds) if (!prev.has(id) && !published.has(id)) next.add(id);
      return next;
    });
  }, [ready.map((a) => a.id).join(',')]);

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function publish(id: string) {
    start(async () => {
      try {
        await publishAsset(id);
        setPublished((s) => new Set(s).add(id));
        setRowErrors((e) => {
          if (!(id in e)) return e;
          const { [id]: _, ...rest } = e;
          return rest;
        });
      } catch (err) {
        // Surface inline so the user sees which row failed and why, instead
        // of a generic 500 in the dev tools.
        const msg = err instanceof Error ? err.message : String(err);
        setRowErrors((e) => ({ ...e, [id]: msg }));
      }
    });
  }

  function publishSelected(): void {
    const ids = Array.from(selected).filter((id) => !published.has(id));
    if (ids.length === 0) return;
    setPollingFor(new Set(ids));
    for (const id of ids) publish(id);
  }

  // Live status poll: while any selected-and-just-dispatched asset is still
  // in flight on the worker (status === 'approved' before it flips to
  // dispatched/published/failed), refresh the page data every 2 s so the
  // operator sees real progress instead of staring at an unchanging panel.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentional — driven by pollingFor only
  useEffect(() => {
    if (pollingFor.size === 0) return;
    const inFlight = data.approval.filter(
      (a) => pollingFor.has(a.id) && (a.status === 'approved' || a.status === 'ready_for_review'),
    );
    if (inFlight.length === 0) {
      // Everything we asked about has reached a terminal state.
      setPollingFor(new Set());
      return;
    }
    const t = setTimeout(() => router.refresh(), 2000);
    return () => clearTimeout(t);
  }, [pollingFor, data.approval.map((a) => `${a.id}:${a.status}`).join(',')]);

  return (
    <aside
      style={{
        background: 'var(--panel)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 48,
        alignSelf: 'start',
        maxHeight: 'calc(100vh - 48px)',
        overflow: 'auto',
      }}
    >
      <div style={{ padding: '14px 16px 12px', borderBottom: '1px solid var(--border)' }}>
        <Eyebrow>Approve &amp; Publish</Eyebrow>
        <div style={{ marginTop: 6, display: 'flex', alignItems: 'baseline', gap: 6 }}>
          <span
            style={{
              fontSize: 26,
              fontWeight: 500,
              fontFamily: 'var(--font-mono)',
              letterSpacing: -0.5,
            }}
          >
            {approvedCount}
          </span>
          <span
            style={{ fontSize: 14, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}
          >
            / {data.approval.length}
          </span>
          <span style={{ fontSize: 11, color: 'var(--text-muted)', marginLeft: 6 }}>
            assets approved
          </span>
        </div>
        <div
          style={{
            marginTop: 10,
            height: 4,
            background: 'var(--bg-elev-2)',
            borderRadius: 999,
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${data.approval.length ? (approvedCount / data.approval.length) * 100 : 0}%`,
              background: 'var(--accent)',
              borderRadius: 999,
              transition: 'width 0.24s',
            }}
          />
        </div>
      </div>

      <div style={{ padding: '10px 10px 0', }}>
        <YoutubePublishOptions
          packageId={data.packageId}
          initialPrivacy={data.youtubeDirect.privacy}
          initialPublishAt={data.youtubeDirect.publishAt}
          visible={data.youtubeDirect.enabled}
        />
      </div>

      <div style={{ padding: 10, flex: 1 }}>
        {data.approval.length === 0 && (
          <div
            style={{ padding: 24, textAlign: 'center', fontSize: 12, color: 'var(--text-faint)' }}
          >
            No assets generated yet.
          </div>
        )}
        {data.approval.map((a) => {
          // Bundled rows don't get their own checkbox or click handler —
          // they're shown as a one-line "Includes:" hint under their parent.
          if (a.bundledInto) return null;
          const bundledChildren = data.approval.filter((c) => c.bundledInto === a.id);
          const inReadyState =
            a.status === 'ready_for_review' || a.status === 'approved' || published.has(a.id);
          const isDispatched =
            a.status === 'dispatched' || a.status === 'published' || a.status === 'failed';
          const blocked = !!a.blocked;
          const interactive = inReadyState && !blocked;
          const checked = selected.has(a.id);
          const err = rowErrors[a.id];
          return (
            <div key={a.id}>
              <button
                type="button"
                disabled={!interactive || pending}
                onClick={() => toggle(a.id)}
                title={
                  blocked
                    ? (a.blocked ?? 'not dispatchable')
                    : interactive
                      ? (checked
                          ? 'Click to exclude from dispatch'
                          : 'Click to include in dispatch')
                      : `Status: ${a.status}`
                }
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '10px 8px',
                  borderRadius: 6,
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  opacity: interactive ? 1 : 0.45,
                  cursor: interactive ? 'pointer' : 'not-allowed',
                }}
                onMouseEnter={(e) => {
                  if (interactive) e.currentTarget.style.background = 'var(--bg-elev-2)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = 'transparent';
                }}
              >
                <span
                  style={{
                    width: 18,
                    height: 18,
                    borderRadius: 4,
                    background: blocked
                      ? 'transparent'
                      : checked
                        ? 'var(--accent)'
                        : 'transparent',
                    border: `1.5px solid ${
                      blocked
                        ? 'var(--border)'
                        : checked
                          ? 'var(--accent)'
                          : 'var(--border-strong)'
                    }`,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: blocked ? 'var(--text-faint)' : '#fff',
                    fontSize: 11,
                    flexShrink: 0,
                  }}
                >
                  {blocked ? '⊘' : checked ? '✓' : ''}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 500,
                      color: interactive ? 'var(--text)' : 'var(--text-muted)',
                    }}
                  >
                    {a.label}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {bundledChildren.length > 0
                      ? `bundles: ${bundledChildren.map((c) => c.label.toLowerCase().replace(/^youtube /, '')).join(' · ')}`
                      : a.sub}
                  </div>
                </div>
                {isDispatched && !blocked && (
                  <span
                    style={{
                      fontSize: 10,
                      color:
                        a.status === 'failed' ? 'var(--status-failed)' : 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    {a.status}
                  </span>
                )}
                {blocked && (
                  <span
                    style={{
                      fontSize: 10,
                      color: 'var(--text-faint)',
                      fontFamily: 'var(--font-mono)',
                    }}
                  >
                    locked
                  </span>
                )}
              </button>
              {a.blocked && (
                <div
                  style={{
                    padding: '0 8px 6px 36px',
                    fontSize: 10,
                    color: 'var(--text-faint)',
                    fontFamily: 'var(--font-mono)',
                    lineHeight: 1.5,
                  }}
                >
                  {a.blocked}
                </div>
              )}
              {(err || (a.status === 'failed' && a.dispatchError)) && (
                <div
                  style={{
                    margin: '2px 6px 8px 36px',
                    padding: '6px 8px',
                    fontSize: 11,
                    color: 'var(--status-failed)',
                    background: 'color-mix(in oklab, var(--status-failed) 8%, transparent)',
                    border:
                      '1px solid color-mix(in oklab, var(--status-failed) 28%, transparent)',
                    borderRadius: 5,
                    lineHeight: 1.45,
                  }}
                >
                  {err ?? a.dispatchError}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div
        style={{
          padding: 14,
          borderTop: '1px solid var(--border)',
          background: 'var(--panel-strong)',
        }}
      >
        <PrimaryBtn
          icon="↗"
          style={{ width: '100%', justifyContent: 'center', padding: '10px 12px' }}
          disabled={selected.size === 0 || pending}
          onClick={publishSelected}
        >
          Approve &amp; dispatch · {selected.size}
        </PrimaryBtn>
        {pollingFor.size > 0 && (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 10px',
              background: 'color-mix(in oklab, var(--status-analyzing) 10%, transparent)',
              border: '1px solid color-mix(in oklab, var(--status-analyzing) 28%, transparent)',
              borderRadius: 6,
              fontSize: 11,
              color: 'var(--status-analyzing)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: 'var(--status-analyzing)',
                animation: 'pulse 1.4s ease-in-out infinite',
              }}
            />
            dispatching {pollingFor.size} · auto-refresh every 2s
          </div>
        )}
        {selected.size !== ready.length && (
          <div
            style={{
              marginTop: 8,
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              gap: 8,
            }}
          >
            <span
              style={{
                fontSize: 10,
                color: 'var(--text-faint)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              {selected.size === 0
                ? 'no assets selected'
                : `${ready.length - selected.size} excluded`}
            </span>
            <button
              type="button"
              onClick={() => setSelected(new Set(ready.map((a) => a.id)))}
              style={{
                fontSize: 10,
                color: 'var(--accent)',
                background: 'transparent',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontFamily: 'var(--font-mono)',
              }}
            >
              select all
            </button>
          </div>
        )}
        <div
          style={{
            marginTop: 10,
            fontSize: 10,
            color: 'var(--text-faint)',
            fontFamily: 'var(--font-mono)',
            lineHeight: 1.5,
          }}
        >
          dispatch targets: YouTube · social via LATE
          <br />
          editorial: DojoClaw (local)
        </div>
      </div>
    </aside>
  );
}

// ── Asset cards (shared by all layouts) ──────────────────────────────────────
function AssetCard({
  title,
  icon,
  count,
  toolbar,
  children,
}: {
  title: string;
  icon: ReactNode;
  count?: number;
  toolbar?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          background: 'var(--panel-strong)',
        }}
      >
        <span
          style={{
            width: 22,
            height: 22,
            background: 'var(--bg-elev-2)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {icon}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        {count != null && (
          <span
            style={{
              fontSize: 10,
              fontFamily: 'var(--font-mono)',
              padding: '1px 5px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 3,
              color: 'var(--text-faint)',
            }}
          >
            {count}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {toolbar && <div style={{ display: 'flex', gap: 6 }}>{toolbar}</div>}
      </div>
      <div style={{ padding: 14 }}>{children}</div>
    </div>
  );
}

function YoutubeStack({ data }: { data: StudioData }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <ThumbnailCard data={data} />
      <TitlesCard data={data} />
      <DescriptionCard data={data} />
      <TagsCard data={data} />
      <TranscriptCard text={data.youtube.transcript} audioReady={data.progress.audio >= 1} />
    </div>
  );
}

function ThumbnailCard({ data }: { data: StudioData }) {
  const [pending, start] = useTransition();
  const [faces, setFaces] = useState('auto');
  const thumbs = data.youtube.thumbnails;
  return (
    <AssetCard
      title="Thumbnails"
      icon="◧"
      count={thumbs.length || undefined}
      toolbar={
        <>
          <select
            value={faces}
            onChange={(e) => setFaces(e.target.value)}
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 11,
              padding: '4px 6px',
              color: 'var(--text)',
            }}
          >
            <option value="auto">Faces: Auto</option>
            <option value="1">1</option>
            <option value="2">2</option>
            <option value="0">None</option>
          </select>
          <PrimaryBtn
            size="sm"
            icon="✦"
            loading={pending}
            onClick={() =>
              start(async () => {
                await generateThumbnails(data.packageId, data.sourceId, faces);
              })
            }
          >
            Generate
          </PrimaryBtn>
        </>
      }
    >
      {thumbs.length === 0 ? (
        <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
          No thumbnails yet — Generate to extract concepts at the hook timestamps.
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {thumbs.map((t, i) => (
            <div
              key={t.id}
              style={{
                position: 'relative',
                aspectRatio: '16 / 9',
                borderRadius: 6,
                overflow: 'hidden',
                border: '1px solid var(--border)',
              }}
            >
              {t.url ? (
                <img
                  src={t.url}
                  alt=""
                  style={{
                    position: 'absolute',
                    inset: 0,
                    width: '100%',
                    height: '100%',
                    objectFit: 'cover',
                  }}
                />
              ) : (
                <MockThumb seed={i} style={{ position: 'absolute', inset: 0 }} />
              )}
              {t.score != null && (
                <div style={{ position: 'absolute', right: 4, top: 4 }}>
                  <ScorePill score={t.score} size="sm" />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </AssetCard>
  );
}

function TitlesCard({ data }: { data: StudioData }) {
  const router = useRouter();
  const id = data.youtube.titlesAssetId;
  const [titles, setTitles] = useState(data.youtube.titles);
  const [sel, setSel] = useState(
    Math.min(data.youtube.selectedIndex, Math.max(titles.length - 1, 0)),
  );
  const [editing, setEditing] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, start] = useTransition();

  if (!id || titles.length === 0) {
    return (
      <AssetCard title="Titles" icon="✎">
        <GenerateInline
          label="titles"
          onGenerate={() => generateSection(data.packageId, 'youtube_title_set')}
          pipelineRunning={!data.analysisReady}
        />
      </AssetCard>
    );
  }

  function persist(next: ScoredItem[], nextSel: number) {
    if (!id) return;
    start(async () => {
      await saveAssetPayload(id, { titles: next, selectedIndex: nextSel });
    });
  }
  function pick(i: number) {
    setSel(i);
    if (id)
      start(async () => {
        await selectTitle(id, i);
      });
  }
  function commitEdit(i: number) {
    const next = titles.map((t, j) => (j === i ? { ...t, text: draft } : t));
    setTitles(next);
    setEditing(null);
    persist(next, sel);
  }

  return (
    <AssetCard
      title="Titles"
      icon="✎"
      count={titles.length}
      toolbar={
        <>
          <GhostBtn
            size="sm"
            icon="✦"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await regenerateAsset(id);
                router.refresh();
              })
            }
          >
            Regenerate
          </GhostBtn>
          <GhostBtn
            size="sm"
            icon="⎘"
            onClick={() => navigator.clipboard.writeText(titles[sel]?.text ?? '')}
          >
            Copy selected
          </GhostBtn>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
        {titles.map((t, i) => {
          const over = t.text.length > 70;
          const selected = i === sel;
          const isEditing = editing === i;
          return (
            <div
              key={`${t.text}-${i}`}
              role="button"
              tabIndex={0}
              onClick={() => !isEditing && pick(i)}
              onKeyDown={(e) => e.key === 'Enter' && !isEditing && pick(i)}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: 10,
                background: selected
                  ? 'color-mix(in oklab, var(--accent) 6%, transparent)'
                  : 'transparent',
                border: `1px solid ${selected ? 'color-mix(in oklab, var(--accent) 30%, transparent)' : 'transparent'}`,
                borderRadius: 7,
                cursor: 'pointer',
              }}
            >
              <span
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: 999,
                  marginTop: 3,
                  border: `1.5px solid ${selected ? 'var(--accent)' : 'var(--border-strong)'}`,
                  background: selected ? 'var(--accent)' : 'transparent',
                  position: 'relative',
                  flexShrink: 0,
                }}
              >
                {selected && (
                  <span
                    style={{
                      position: 'absolute',
                      inset: 3,
                      borderRadius: 999,
                      background: '#fff',
                    }}
                  />
                )}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {isEditing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={() => commitEdit(i)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitEdit(i);
                      if (e.key === 'Escape') setEditing(null);
                    }}
                    style={{
                      width: '100%',
                      padding: '4px 6px',
                      background: 'var(--bg)',
                      border: '1px solid var(--accent)',
                      borderRadius: 4,
                      fontSize: 13,
                      outline: 'none',
                      color: 'var(--text)',
                    }}
                  />
                ) : (
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditing(i);
                      setDraft(t.text);
                    }}
                    onKeyDown={() => {}}
                    style={{
                      fontSize: 13,
                      fontWeight: selected ? 500 : 400,
                      color: selected ? 'var(--text)' : 'var(--text-muted)',
                      lineHeight: 1.45,
                    }}
                  >
                    {t.text}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 11,
                    color: over ? 'var(--status-failed)' : 'var(--text-faint)',
                  }}
                >
                  {t.text.length}
                  <span style={{ opacity: 0.5 }}>/70</span>
                </span>
                {t.score != null && <ScorePill score={t.score} />}
              </div>
            </div>
          );
        })}
      </div>
    </AssetCard>
  );
}

function DescriptionCard({ data }: { data: StudioData }) {
  const router = useRouter();
  const id = data.youtube.descriptionAssetId;
  const [text, setText] = useState(data.youtube.description);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const [pending, start] = useTransition();

  if (!id) {
    return (
      <AssetCard title="Description" icon="¶">
        <GenerateInline
          label="description"
          onGenerate={() => generateSection(data.packageId, 'youtube_description')}
          pipelineRunning={!data.analysisReady}
        />
      </AssetCard>
    );
  }

  return (
    <AssetCard
      title="Description"
      icon="¶"
      toolbar={
        <>
          <GhostBtn
            size="sm"
            icon="✦"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await regenerateAsset(id);
                router.refresh();
              })
            }
          >
            Regenerate
          </GhostBtn>
          <GhostBtn size="sm" icon="⎘" onClick={() => navigator.clipboard.writeText(text)}>
            Copy
          </GhostBtn>
          <GhostBtn
            size="sm"
            icon={editing ? '✓' : '✎'}
            onClick={() => {
              if (editing) {
                setText(draft);
                start(async () => {
                  await saveAssetPayload(id, { text: draft });
                });
              } else {
                setDraft(text);
              }
              setEditing((e) => !e);
            }}
          >
            {editing ? 'Done' : 'Edit'}
          </GhostBtn>
        </>
      }
    >
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          style={{
            width: '100%',
            minHeight: 280,
            background: 'var(--bg)',
            border: '1px solid var(--accent)',
            borderRadius: 6,
            padding: 10,
            fontSize: 13,
            lineHeight: 1.6,
            outline: 'none',
            color: 'var(--text)',
            resize: 'vertical',
            fontFamily: 'var(--font-sans)',
          }}
        />
      ) : (
        <div
          style={{
            fontSize: 13,
            lineHeight: 1.65,
            color: 'var(--text-muted)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {text}
        </div>
      )}
      <div
        style={{
          marginTop: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          fontSize: 11,
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <span>{(editing ? draft : text).length} chars</span>
        <span>·</span>
        <span>{(editing ? draft : text).split(/\s+/).filter(Boolean).length} words</span>
      </div>
    </AssetCard>
  );
}

function TagsCard({ data }: { data: StudioData }) {
  const router = useRouter();
  const id = data.youtube.tagsAssetId;
  const [pending, start] = useTransition();
  if (!id || data.youtube.tags.length === 0) {
    return (
      <AssetCard title="Tags" icon="#">
        <GenerateInline
          label="tags"
          onGenerate={() => generateSection(data.packageId, 'youtube_tags')}
          pipelineRunning={!data.analysisReady}
        />
      </AssetCard>
    );
  }
  return (
    <AssetCard
      title="Tags"
      icon="#"
      count={data.youtube.tags.length}
      toolbar={
        <>
          <GhostBtn
            size="sm"
            icon="✦"
            disabled={pending}
            onClick={() =>
              start(async () => {
                await regenerateAsset(id);
                router.refresh();
              })
            }
          >
            Regenerate
          </GhostBtn>
          <GhostBtn
            size="sm"
            icon="⎘"
            onClick={() =>
              navigator.clipboard.writeText(data.youtube.tags.map((t) => t.text).join(', '))
            }
          >
            Copy
          </GhostBtn>
        </>
      }
    >
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {data.youtube.tags.map((t, i) => (
          <span
            key={`${t.text}-${i}`}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '4px 6px 4px 10px',
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 999,
              fontSize: 12,
            }}
          >
            {t.text}
            {t.score != null && <ScorePill score={t.score} size="sm" />}
          </span>
        ))}
      </div>
    </AssetCard>
  );
}

function TranscriptCard({ text, audioReady }: { text: string; audioReady: boolean }) {
  const [open, setOpen] = useState(false);
  if (!text) {
    return (
      <AssetCard title="Transcript" icon="≡">
        <div style={{ textAlign: 'center', padding: '20px 8px' }}>
          {audioReady ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>
              Transcript not ready yet.
            </div>
          ) : (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 14px',
                background: 'color-mix(in oklab, var(--status-analyzing) 10%, transparent)',
                border: '1px solid color-mix(in oklab, var(--status-analyzing) 28%, transparent)',
                borderRadius: 999,
                fontSize: 12,
                color: 'var(--status-analyzing)',
                fontFamily: 'var(--font-mono)',
              }}
            >
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: 'var(--status-analyzing)',
                  animation: 'pulse 1.4s ease-in-out infinite',
                }}
              />
              transcribing audio — generates automatically
            </div>
          )}
        </div>
      </AssetCard>
    );
  }
  return (
    <AssetCard
      title="Transcript"
      icon="≡"
      toolbar={
        <>
          <GhostBtn size="sm" icon="⎘" onClick={() => navigator.clipboard.writeText(text)}>
            Copy
          </GhostBtn>
          <GhostBtn size="sm" onClick={() => setOpen((o) => !o)}>
            {open ? 'Collapse ▴' : 'Expand ▾'}
          </GhostBtn>
        </>
      }
    >
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.6,
          color: 'var(--text-muted)',
          whiteSpace: 'pre-wrap',
          maxHeight: open ? 'none' : 86,
          overflow: 'hidden',
          position: 'relative',
          fontFamily: 'var(--font-mono)',
        }}
      >
        {text}
        {!open && (
          <div
            style={{
              position: 'absolute',
              left: 0,
              right: 0,
              bottom: 0,
              height: 40,
              background: 'linear-gradient(180deg, transparent, var(--panel))',
              pointerEvents: 'none',
            }}
          />
        )}
      </div>
    </AssetCard>
  );
}

function GenerateInline({
  label,
  onGenerate,
  pipelineRunning,
}: {
  label: string;
  onGenerate: () => Promise<void>;
  /** True while the package's analysis hasn't completed yet — generate_asset will fire automatically. */
  pipelineRunning?: boolean;
}) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // While the upstream pipeline is still running, the generate_asset worker
  // will fire automatically as soon as analyze_intelligence completes — show
  // a quiet status indicator instead of a misleading "Generate" button.
  if (pipelineRunning) {
    return (
      <div style={{ textAlign: 'center', padding: '20px 8px' }}>
        <div
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '8px 14px',
            background: 'color-mix(in oklab, var(--status-analyzing) 10%, transparent)',
            border: '1px solid color-mix(in oklab, var(--status-analyzing) 28%, transparent)',
            borderRadius: 999,
            fontSize: 12,
            color: 'var(--status-analyzing)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: 'var(--status-analyzing)',
              animation: 'pulse 1.4s ease-in-out infinite',
            }}
          />
          {label} — generates automatically when analysis completes
        </div>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', padding: '20px 8px' }}>
      <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>No {label} yet</div>
      <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 12 }}>
        Generation completed but produced no asset — generate manually below
      </div>
      <PrimaryBtn
        size="sm"
        icon="✦"
        loading={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            try {
              await onGenerate();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          })
        }
      >
        Generate {label}
      </PrimaryBtn>
      {error && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--status-failed)' }}>{error}</div>
      )}
    </div>
  );
}

function PlatformAssets({ data, platform }: { data: StudioData; platform: string }) {
  const list = data.assetsByTab[platform] ?? [];
  const label = data.tabs.find((t) => t.key === platform)?.label ?? platform;
  if (list.length === 0) {
    return (
      <div
        style={{
          padding: '32px 18px',
          background: 'var(--panel)',
          border: '1px dashed var(--border-strong)',
          borderRadius: 10,
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 4 }}>No {label} assets yet</div>
        <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          The pipeline drafts these from the analysis; check back as it completes.
        </div>
      </div>
    );
  }
  return (
    <AssetCard
      title={label}
      icon={<PlatformIcon platform={platform} size={14} />}
      count={list.length}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {list.map((a) => {
          const text = (a.payload as { text?: string }).text ?? JSON.stringify(a.payload, null, 2);
          return (
            <div
              key={a.id}
              style={{
                padding: 12,
                background: 'var(--bg-elev-2)',
                border: '1px solid var(--border)',
                borderRadius: 8,
              }}
            >
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-faint)',
                  fontFamily: 'var(--font-mono)',
                  marginBottom: 6,
                }}
              >
                {a.type}
              </div>
              <div style={{ fontSize: 13, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>{text}</div>
            </div>
          );
        })}
      </div>
    </AssetCard>
  );
}

// ── Editor layout ────────────────────────────────────────────────────────────
function EditorLayout({
  data,
  activePlatform,
  setActivePlatform,
}: { data: StudioData; activePlatform: string; setActivePlatform: (p: string) => void }) {
  const [asset, setAsset] = useState<string>('title');
  const router = useRouter();

  const tree = data.tabs.map((t) => {
    if (t.key === 'youtube') {
      return {
        key: 'youtube',
        label: t.label,
        items: [
          { key: 'title', name: 'title.txt', ready: !!data.youtube.titlesAssetId },
          { key: 'description', name: 'description.md', ready: !!data.youtube.descriptionAssetId },
          { key: 'tags', name: 'tags.json', ready: !!data.youtube.tagsAssetId },
        ],
      };
    }
    const list = data.assetsByTab[t.key] ?? [];
    return {
      key: t.key,
      label: t.label,
      items: list.map((a) => ({ key: a.id, name: `${a.type}`, ready: true })),
    };
  });

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '260px 1fr 320px',
        minHeight: 'calc(100vh - 48px)',
      }}
    >
      <aside
        style={{
          background: 'var(--panel)',
          position: 'sticky',
          top: 48,
          alignSelf: 'start',
          maxHeight: 'calc(100vh - 48px)',
          overflow: 'auto',
        }}
      >
        <div style={{ padding: '12px 12px 8px', borderBottom: '1px solid var(--border)' }}>
          <button
            type="button"
            onClick={() => router.push('/')}
            style={{
              fontSize: 11,
              color: 'var(--text-muted)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            ← All packages
          </button>
          <div style={{ marginTop: 8 }}>
            <Pipeline progress={data.progress} compact />
          </div>
        </div>
        <div style={{ padding: '4px 6px' }}>
          {tree.map((g) => (
            <div key={g.key} style={{ marginBottom: 4 }}>
              <button
                type="button"
                onClick={() => setActivePlatform(g.key)}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '5px 8px',
                  fontSize: 11,
                  fontWeight: 500,
                  color: 'var(--text-muted)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <PlatformIcon platform={g.key} size={14} />
                <span>{g.label}</span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    fontSize: 9,
                    color: 'var(--text-faint)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {g.items.filter((i) => i.ready).length}/{g.items.length}
                </span>
              </button>
              {activePlatform === g.key &&
                g.items.map((a) => {
                  const active = asset === a.key;
                  return (
                    <button
                      key={a.key}
                      type="button"
                      onClick={() => setAsset(a.key)}
                      style={{
                        width: '100%',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 7,
                        padding: '4px 8px 4px 26px',
                        borderRadius: 4,
                        background: active ? 'var(--accent-soft)' : 'transparent',
                        color: active ? 'var(--accent)' : 'var(--text-muted)',
                        textAlign: 'left',
                        fontSize: 11,
                        fontFamily: 'var(--font-mono)',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: 999,
                          background: a.ready ? 'var(--status-published)' : 'var(--border-strong)',
                        }}
                      />
                      <span
                        style={{
                          flex: 1,
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        {a.name}
                      </span>
                    </button>
                  );
                })}
            </div>
          ))}
        </div>
      </aside>

      <div
        style={{
          borderLeft: '1px solid var(--border)',
          borderRight: '1px solid var(--border)',
          background: 'var(--bg)',
        }}
      >
        <div style={{ padding: 24 }}>
          {activePlatform === 'youtube' && asset === 'title' && (
            <div style={{ maxWidth: 760 }}>
              <Eyebrow style={{ marginBottom: 10 }}>YouTube · title set</Eyebrow>
              <h2
                className="serif"
                style={{ fontSize: 28, fontWeight: 400, margin: '0 0 18px', letterSpacing: -0.3 }}
              >
                Pick the title that earns the click.
              </h2>
              <TitlesCard data={data} />
            </div>
          )}
          {activePlatform === 'youtube' && asset === 'description' && (
            <div style={{ maxWidth: 760 }}>
              <Eyebrow style={{ marginBottom: 10 }}>YouTube · description</Eyebrow>
              <DescriptionCard data={data} />
            </div>
          )}
          {activePlatform === 'youtube' && asset === 'tags' && (
            <div style={{ maxWidth: 760 }}>
              <Eyebrow style={{ marginBottom: 10 }}>YouTube · tags</Eyebrow>
              <TagsCard data={data} />
            </div>
          )}
          {activePlatform !== 'youtube' && (
            <div style={{ maxWidth: 760 }}>
              <Eyebrow style={{ marginBottom: 10 }}>
                {data.tabs.find((t) => t.key === activePlatform)?.label}
              </Eyebrow>
              {activePlatform === 'shorts' ? (
                <ShortsList packageId={data.packageId} rows={data.shorts} />
              ) : (
                <PlatformAssets data={data} platform={activePlatform} />
              )}
            </div>
          )}
        </div>
      </div>

      <aside
        style={{
          background: 'var(--panel)',
          position: 'sticky',
          top: 48,
          alignSelf: 'start',
          maxHeight: 'calc(100vh - 48px)',
          overflow: 'auto',
          padding: 14,
        }}
      >
        <Eyebrow>Inspector</Eyebrow>
        <div
          style={{ marginTop: 8, fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-mono)' }}
        >
          {activePlatform}/{asset}
        </div>
        <div style={{ marginTop: 14 }}>
          <Eyebrow>Pipeline</Eyebrow>
          <div style={{ marginTop: 8 }}>
            <Pipeline progress={data.progress} details={data.pipelineDetails} layout="col" />
          </div>
        </div>
        <div style={{ marginTop: 14 }}>
          <Eyebrow>Assets</Eyebrow>
          <div style={{ marginTop: 8, display: 'flex', gap: 12 }}>
            <Stat
              label="Ready"
              value={data.counts.ready}
              total={data.counts.total}
              color="var(--status-published)"
            />
            <Stat label="Pending" value={data.counts.pending} color="var(--status-analyzing)" />
            <Stat label="Failed" value={data.counts.failed} color="var(--status-failed)" />
          </div>
        </div>
      </aside>
    </div>
  );
}

// ── Atlas layout ─────────────────────────────────────────────────────────────
function AtlasLayout({
  data,
  setActivePlatform,
}: { data: StudioData; activePlatform: string; setActivePlatform: (p: string) => void }) {
  const [focused, setFocused] = useState<string | null>(null);
  const groups: { id: 'video' | 'editorial' | 'social'; title: string; subtitle: string }[] = [
    { id: 'video', title: 'Video', subtitle: 'Long-form, shorts, and clip cuts' },
    { id: 'editorial', title: 'Editorial', subtitle: 'Long-form text destinations' },
    { id: 'social', title: 'Social', subtitle: 'Drafted from the same source' },
  ];
  return (
    <div>
      <div style={{ maxWidth: 1400, margin: '0 auto', padding: '20px 32px 80px' }}>
        <StudioHeaderInline data={data} />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.4fr 1fr',
            gap: 16,
            margin: '20px 0 28px',
          }}
        >
          <VideoPlayer data={data} />
          <PipelinePanel data={data} />
        </div>
        {groups.map((g) => {
          const platforms = data.tabs.filter((t) => groupOf(t.key) === g.id);
          if (platforms.length === 0) return null;
          return (
            <section key={g.id} style={{ marginBottom: 32 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 12 }}>
                <Eyebrow>{g.title}</Eyebrow>
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{g.subtitle}</span>
              </div>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns:
                    g.id === 'video' ? 'repeat(3, 1fr)' : 'repeat(auto-fill, minmax(220px, 1fr))',
                  gap: 10,
                }}
              >
                {platforms.map((t) => {
                  const c = completionFor(data, t.key);
                  const ready = c >= 1;
                  const partial = c > 0 && c < 1;
                  return (
                    <button
                      key={t.key}
                      type="button"
                      onClick={() => {
                        setFocused(t.key);
                        setActivePlatform(t.key);
                      }}
                      style={{
                        background: 'var(--panel)',
                        border: '1px solid var(--border)',
                        borderRadius: 10,
                        padding: 14,
                        textAlign: 'left',
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 10,
                        minHeight: g.id === 'video' ? 110 : 92,
                        cursor: 'pointer',
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                        <PlatformIcon platform={t.key} size={26} active={ready} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{t.label}</div>
                          <div
                            style={{
                              fontSize: 10,
                              color: 'var(--text-faint)',
                              fontFamily: 'var(--font-mono)',
                              marginTop: 1,
                            }}
                          >
                            {ready
                              ? 'all assets ready'
                              : partial
                                ? 'partially ready'
                                : 'not started'}
                          </div>
                        </div>
                        {ready && (
                          <span style={{ color: 'var(--status-published)', fontSize: 14 }}>✓</span>
                        )}
                        {partial && (
                          <span className="spinner" style={{ color: 'var(--status-analyzing)' }} />
                        )}
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <div
                          style={{
                            flex: 1,
                            height: 3,
                            background: 'var(--bg-elev-2)',
                            borderRadius: 999,
                            overflow: 'hidden',
                          }}
                        >
                          <div
                            style={{
                              height: '100%',
                              width: `${c * 100}%`,
                              background: ready
                                ? 'var(--status-published)'
                                : partial
                                  ? 'var(--status-analyzing)'
                                  : 'transparent',
                              transition: 'width 0.4s',
                            }}
                          />
                        </div>
                        <span
                          style={{
                            fontSize: 10,
                            color: 'var(--text-faint)',
                            fontFamily: 'var(--font-mono)',
                          }}
                        >
                          {Math.round(c * 100)}%
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {focused && (
        <div
          role="presentation"
          onClick={() => setFocused(null)}
          style={{
            position: 'fixed',
            inset: 0,
            zIndex: 100,
            background: 'rgba(0,0,0,0.6)',
            backdropFilter: 'blur(4px)',
            display: 'flex',
            justifyContent: 'flex-end',
            animation: 'fade-in 0.16s',
          }}
        >
          <div
            role="dialog"
            aria-modal
            onClick={(e) => e.stopPropagation()}
            style={{
              width: 'min(680px, 100%)',
              background: 'var(--bg)',
              borderLeft: '1px solid var(--border)',
              boxShadow: '-12px 0 32px rgba(0,0,0,0.4)',
              overflow: 'auto',
              animation: 'slide-up 0.2s ease-out',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '16px 20px',
                borderBottom: '1px solid var(--border)',
                position: 'sticky',
                top: 0,
                background: 'var(--bg)',
                zIndex: 5,
              }}
            >
              <PlatformIcon platform={focused} size={22} active />
              <span style={{ fontSize: 14, fontWeight: 600 }}>
                {data.tabs.find((t) => t.key === focused)?.label}
              </span>
              <span style={{ flex: 1 }} />
              <button
                type="button"
                onClick={() => setFocused(null)}
                style={{
                  fontSize: 13,
                  color: 'var(--text-muted)',
                  padding: 4,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                esc
              </button>
            </div>
            <div style={{ padding: 20, display: 'flex', flexDirection: 'column', gap: 14 }}>
              {focused === 'youtube' ? (
                <YoutubeStack data={data} />
              ) : focused === 'shorts' ? (
                <ShortsList packageId={data.packageId} rows={data.shorts} />
              ) : (
                <PlatformAssets data={data} platform={focused} />
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function StudioHeaderInline({ data }: { data: StudioData }) {
  const router = useRouter();
  const selected = data.youtube.titles[data.youtube.selectedIndex]?.text;
  const title = selected ?? data.packageId;
  return (
    <div>
      <button
        type="button"
        onClick={() => router.push('/')}
        style={{
          fontSize: 11,
          color: 'var(--text-muted)',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
        }}
      >
        ← All packages
      </button>
      <h1
        className="serif"
        style={{
          fontSize: 26,
          fontWeight: 400,
          margin: '8px 0 0',
          lineHeight: 1.15,
          letterSpacing: -0.3,
        }}
      >
        {title}
      </h1>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 8,
          fontSize: 11,
          color: 'var(--text-muted)',
        }}
      >
        <Avatar
          glyph={data.brand.slug.slice(0, 2).toUpperCase()}
          color={brandColor(data.brand.slug)}
          size={18}
        />
        {data.brand.name}
        <span style={{ color: 'var(--text-faint)' }}>·</span>
        <StatusPill status={data.pkg.status} />
      </div>
    </div>
  );
}

// ── Video player (real media) ────────────────────────────────────────────────
function VideoPlayer({ data }: { data: StudioData }) {
  return (
    <div
      style={{
        position: 'relative',
        borderRadius: 10,
        overflow: 'hidden',
        background: '#000',
        border: '1px solid var(--border)',
        aspectRatio: '16 / 9',
      }}
    >
      {data.videoUrl ? (
        // biome-ignore lint/a11y/useMediaCaption: source video has no caption track
        <video
          src={data.videoUrl}
          controls
          style={{
            position: 'absolute',
            inset: 0,
            width: '100%',
            height: '100%',
            objectFit: 'contain',
            background: '#000',
          }}
        />
      ) : (
        <>
          <MockThumb seed={1} style={{ position: 'absolute', inset: 0 }} label={data.packageId} />
          <div
            style={{
              position: 'absolute',
              inset: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'rgba(255,255,255,0.7)',
              fontSize: 12,
            }}
          >
            video not available
          </div>
        </>
      )}
    </div>
  );
}
