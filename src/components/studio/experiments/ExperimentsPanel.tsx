'use client';

/**
 * ExperimentsPanel — YouTube title/thumbnail A/B test UI for the Studio.
 *
 * Mount point: ConsoleLayout > YoutubeStack (when activePlatform === 'youtube')
 * at the bottom of the stack, rendered from StudioShell.
 *
 * Props come from the server page (page.tsx) and are passed down through
 * StudioData. Server actions (createExperiment, startExperiment,
 * cancelExperiment) are called directly.
 */

import { Eyebrow, GhostBtn, PrimaryBtn, StatusPill } from '@/components/ui';
import { Modal } from '@/components/ui/Modal';
import type { ExperimentObservation, ExperimentVariant } from '@/db/schema/experiments';
import {
  type CreateExperimentInput,
  cancelExperiment,
  createExperiment,
  startExperiment,
} from '@/server-actions/experiments';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

// ─── Prop types ───────────────────────────────────────────────────────────────

export type ExperimentTitleOption = {
  index: number;
  text: string;
  score: number | null;
};

export type ExperimentThumbnailOption = {
  assetId: string;
  mediaUrl: string | null; // null when local_path resolves to nothing
  variant: 'plain' | 'headline' | 'frame';
  headline: string | null;
  rank: number | null;
  localPath: string | null; // raw path for thumbnail_path on variant
};

export type ExperimentRow = {
  id: string;
  kind: string;
  status: string;
  metric: string;
  videoId: string;
  rotationHours: number;
  rounds: number;
  minViews: number;
  currentVariant: number | null;
  currentCycle: number;
  winnerVariant: number | null;
  lastError: string | null;
  startedAt: string | null;
  decidedAt: string | null;
  createdAt: string;
  variants: ExperimentVariant[];
};

export type ExperimentsPanelProps = {
  packageId: string;
  brandSlug: string;
  hasPublishedVideo: boolean; // whether there's a YouTube video id on this package
  analyticsGranted: boolean; // whether the brand's YouTube OAuth includes yt-analytics
  titleOptions: ExperimentTitleOption[]; // from youtube_title_set
  thumbnailOptions: ExperimentThumbnailOption[]; // from thumbnail_concept assets
  experiments: ExperimentRow[];
};

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ExperimentsPanel({
  packageId,
  brandSlug,
  hasPublishedVideo,
  analyticsGranted,
  titleOptions,
  thumbnailOptions,
  experiments,
}: ExperimentsPanelProps) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        overflow: 'hidden',
        marginTop: 14,
      }}
    >
      {/* Header */}
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
          ⚖
        </span>
        <span style={{ fontSize: 13, fontWeight: 600 }}>A/B Tests</span>
        {experiments.length > 0 && (
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
            {experiments.length}
          </span>
        )}
        <span style={{ flex: 1 }} />
        {hasPublishedVideo && (
          <GhostBtn size="sm" icon="+" onClick={() => setModalOpen(true)}>
            New A/B test
          </GhostBtn>
        )}
      </div>

      {/* Body */}
      <div style={{ padding: 14 }}>
        {/* Blocked: no published video */}
        {!hasPublishedVideo && (
          <div
            style={{
              padding: '14px 16px',
              background: 'color-mix(in oklab, var(--text-faint) 6%, transparent)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
              color: 'var(--text-muted)',
              lineHeight: 1.6,
            }}
          >
            <strong style={{ color: 'var(--text)' }}>No published YouTube video yet.</strong>
            <br />
            Publish this package via YouTube Direct first — A/B tests require a live video id to
            rotate the title and thumbnail.
          </div>
        )}

        {/* Warning: analytics scope missing */}
        {hasPublishedVideo && !analyticsGranted && (
          <div
            style={{
              marginBottom: 14,
              padding: '10px 14px',
              background: 'color-mix(in oklab, var(--status-scheduled) 8%, transparent)',
              border: '1px solid color-mix(in oklab, var(--status-scheduled) 28%, transparent)',
              borderRadius: 8,
              fontSize: 12,
              color: 'color-mix(in oklab, var(--status-scheduled) 90%, var(--text))',
              lineHeight: 1.6,
            }}
          >
            <strong>Analytics scope missing.</strong> The YouTube OAuth for this brand doesn&apos;t
            include{' '}
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
              yt-analytics.readonly
            </code>
            . You can still create draft experiments, but the winner won&apos;t be decided
            automatically.{' '}
            <a
              href={`/brands/${brandSlug}`}
              style={{ color: 'inherit', textDecorationLine: 'underline' }}
            >
              Reconnect YouTube on the brand page
            </a>{' '}
            to grant the scope.
          </div>
        )}

        {/* Experiment list */}
        {hasPublishedVideo && experiments.length === 0 && (
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-faint)',
              textAlign: 'center',
              padding: '16px 0',
            }}
          >
            No experiments yet. Click &quot;New A/B test&quot; to set one up.
          </div>
        )}
        {experiments.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {experiments.map((exp) => (
              <ExperimentCard
                key={exp.id}
                exp={exp}
                titleOptions={titleOptions}
                thumbnailOptions={thumbnailOptions}
              />
            ))}
          </div>
        )}
      </div>

      {/* Create modal */}
      <CreateExperimentModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        packageId={packageId}
        titleOptions={titleOptions}
        thumbnailOptions={thumbnailOptions}
      />
    </div>
  );
}

// ─── Experiment card ──────────────────────────────────────────────────────────

function ExperimentCard({
  exp,
  titleOptions,
  thumbnailOptions,
}: {
  exp: ExperimentRow;
  titleOptions: ExperimentTitleOption[];
  thumbnailOptions: ExperimentThumbnailOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const isActive = exp.status === 'running' || exp.status === 'draft';
  const isDecided = exp.status === 'decided';

  function handleCancel() {
    if (!confirm('Cancel this experiment? The currently-applied variant stays on the video.'))
      return;
    start(async () => {
      try {
        setError(null);
        await cancelExperiment(exp.id);
        router.refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  return (
    <div
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {/* Card header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '8px 12px',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <StatusPill status={exp.status} />
        <span
          style={{
            fontSize: 11,
            fontWeight: 500,
            fontFamily: 'var(--font-mono)',
            color: 'var(--text-muted)',
          }}
        >
          {kindLabel(exp.kind)}
        </span>
        <span style={{ color: 'var(--text-faint)', fontSize: 11 }}>·</span>
        <span style={{ fontSize: 11, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
          {metricLabel(exp.metric)}
        </span>
        <span style={{ flex: 1 }} />
        {exp.currentVariant != null && exp.status === 'running' && (
          <span
            style={{
              fontSize: 10,
              color: 'var(--status-analyzing)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            live: {variantLabel(exp, exp.currentVariant)}
          </span>
        )}
        {isDecided && exp.winnerVariant != null && (
          <span
            style={{
              fontSize: 10,
              fontWeight: 600,
              color: 'var(--status-published)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            winner: {variantLabel(exp, exp.winnerVariant)}
          </span>
        )}
        {isActive && (
          <GhostBtn size="sm" danger disabled={pending} onClick={handleCancel}>
            Cancel
          </GhostBtn>
        )}
      </div>

      {/* Variants */}
      <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        {exp.variants.map((v) => (
          <VariantRow
            key={v.variant_index}
            variant={v}
            isWinner={isDecided && exp.winnerVariant === v.variant_index}
            isCurrent={exp.status === 'running' && exp.currentVariant === v.variant_index}
            titleOptions={titleOptions}
            thumbnailOptions={thumbnailOptions}
          />
        ))}
      </div>

      {/* Meta line */}
      <div
        style={{
          padding: '6px 12px 8px',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          fontSize: 10,
          color: 'var(--text-faint)',
          fontFamily: 'var(--font-mono)',
          borderTop: '1px solid var(--border)',
        }}
      >
        <span>
          {exp.rotationHours}h rotation · {exp.rounds} round{exp.rounds !== 1 ? 's' : ''} ·{' '}
          {exp.minViews} min views
        </span>
        {exp.startedAt && (
          <>
            <span>·</span>
            <span>started {formatDate(exp.startedAt)}</span>
          </>
        )}
        {exp.decidedAt && (
          <>
            <span>·</span>
            <span>decided {formatDate(exp.decidedAt)}</span>
          </>
        )}
        <span>·</span>
        <span style={{ fontFamily: 'var(--font-mono)', opacity: 0.6 }}>{exp.id.slice(0, 16)}</span>
      </div>

      {/* Error */}
      {(error ?? exp.lastError) && (
        <div
          style={{
            margin: '0 12px 10px',
            padding: '6px 8px',
            fontSize: 11,
            color: 'var(--status-failed)',
            background: 'color-mix(in oklab, var(--status-failed) 8%, transparent)',
            border: '1px solid color-mix(in oklab, var(--status-failed) 28%, transparent)',
            borderRadius: 5,
            lineHeight: 1.45,
          }}
        >
          {error ?? exp.lastError}
        </div>
      )}
    </div>
  );
}

// ─── Variant row ──────────────────────────────────────────────────────────────

function VariantRow({
  variant,
  isWinner,
  isCurrent,
  titleOptions,
  thumbnailOptions,
}: {
  variant: ExperimentVariant;
  isWinner: boolean;
  isCurrent: boolean;
  titleOptions: ExperimentTitleOption[];
  thumbnailOptions: ExperimentThumbnailOption[];
}) {
  const thumb = variant.thumbnail_asset_id
    ? thumbnailOptions.find((t) => t.assetId === variant.thumbnail_asset_id)
    : null;

  const totalObs = sumObservations(variant.observations);

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '6px 8px',
        borderRadius: 6,
        background: isWinner
          ? 'color-mix(in oklab, var(--status-published) 6%, transparent)'
          : isCurrent
            ? 'color-mix(in oklab, var(--status-analyzing) 6%, transparent)'
            : 'transparent',
        border: `1px solid ${
          isWinner
            ? 'color-mix(in oklab, var(--status-published) 24%, transparent)'
            : isCurrent
              ? 'color-mix(in oklab, var(--status-analyzing) 20%, transparent)'
              : 'transparent'
        }`,
      }}
    >
      {/* Variant label badge */}
      <span
        style={{
          flexShrink: 0,
          width: 22,
          height: 22,
          borderRadius: 5,
          background: isWinner
            ? 'var(--status-published)'
            : isCurrent
              ? 'var(--status-analyzing)'
              : 'var(--bg-elev)',
          color: isWinner || isCurrent ? '#fff' : 'var(--text-muted)',
          border: '1px solid var(--border)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 11,
          fontWeight: 700,
          fontFamily: 'var(--font-mono)',
        }}
      >
        {variant.label}
      </span>

      {/* Thumbnail preview */}
      {thumb?.mediaUrl && (
        <div
          style={{
            flexShrink: 0,
            width: 64,
            height: 36,
            borderRadius: 4,
            overflow: 'hidden',
            border: '1px solid var(--border)',
          }}
        >
          <img
            src={thumb.mediaUrl}
            alt=""
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        </div>
      )}

      {/* Title + observations */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {variant.title && (
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text)',
              marginBottom: 2,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {variant.title}
          </div>
        )}
        {!variant.title && variant.thumbnail_asset_id && (
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
              marginBottom: 2,
            }}
          >
            thumbnail only
          </div>
        )}
        {/* Accumulated metrics */}
        <ObservationSummary obs={totalObs} metric={null} />
      </div>

      {/* Winner badge */}
      {isWinner && (
        <span
          style={{
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--status-published)',
            fontFamily: 'var(--font-mono)',
            flexShrink: 0,
          }}
        >
          ✓ winner
        </span>
      )}
    </div>
  );
}

// ─── Observation summary ──────────────────────────────────────────────────────

type AccumulatedObs = {
  views: number;
  impressions: number | null;
  impression_ctr: number | null;
  estimated_minutes_watched: number | null;
  cycles: number;
};

function sumObservations(obs: ExperimentObservation[]): AccumulatedObs {
  if (obs.length === 0) {
    return {
      views: 0,
      impressions: null,
      impression_ctr: null,
      estimated_minutes_watched: null,
      cycles: 0,
    };
  }
  let views = 0;
  let impressions: number | null = null;
  let ctrSum: number | null = null;
  let ctrCount = 0;
  let watched: number | null = null;
  for (const o of obs) {
    views += o.views;
    if (o.impressions != null) {
      impressions = (impressions ?? 0) + o.impressions;
    }
    if (o.impression_ctr != null) {
      ctrSum = (ctrSum ?? 0) + o.impression_ctr;
      ctrCount++;
    }
    if (o.estimated_minutes_watched != null) {
      watched = (watched ?? 0) + o.estimated_minutes_watched;
    }
  }
  return {
    views,
    impressions,
    impression_ctr: ctrSum != null && ctrCount > 0 ? ctrSum / ctrCount : null,
    estimated_minutes_watched: watched,
    cycles: obs.length,
  };
}

function ObservationSummary({ obs }: { obs: AccumulatedObs; metric: string | null }) {
  if (obs.cycles === 0) {
    return (
      <div style={{ fontSize: 10, color: 'var(--text-faint)', fontFamily: 'var(--font-mono)' }}>
        no data yet
      </div>
    );
  }
  const parts: string[] = [`${obs.views.toLocaleString()} views`];
  if (obs.impression_ctr != null) {
    parts.push(`${(obs.impression_ctr * 100).toFixed(1)}% CTR`);
  }
  if (obs.estimated_minutes_watched != null) {
    parts.push(`${Math.round(obs.estimated_minutes_watched).toLocaleString()} min watched`);
  }
  return (
    <div
      style={{
        fontSize: 10,
        color: 'var(--text-faint)',
        fontFamily: 'var(--font-mono)',
        lineHeight: 1.5,
      }}
    >
      {parts.join(' · ')}
      {obs.cycles > 1 && <span style={{ opacity: 0.7 }}> · {obs.cycles} cycles</span>}
    </div>
  );
}

// ─── Create modal ─────────────────────────────────────────────────────────────

type VariantDraft = {
  label: string;
  titleOptionIndex: number | null; // index into titleOptions (or null)
  thumbnailIndex: number | null; // index into thumbnailOptions (or null)
};

const DEFAULT_VARIANT: VariantDraft = { label: '', titleOptionIndex: null, thumbnailIndex: null };

function CreateExperimentModal({
  open,
  onClose,
  packageId,
  titleOptions,
  thumbnailOptions,
}: {
  open: boolean;
  onClose: () => void;
  packageId: string;
  titleOptions: ExperimentTitleOption[];
  thumbnailOptions: ExperimentThumbnailOption[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Form fields
  const [kind, setKind] = useState<'title' | 'thumbnail' | 'title_thumbnail'>('title');
  const [metric, setMetric] = useState<'views' | 'impression_ctr' | 'estimated_minutes_watched'>(
    'views',
  );
  const [rotationHours, setRotationHours] = useState(48);
  const [rounds, setRounds] = useState(1);
  const [minViews, setMinViews] = useState(50);
  const [variants, setVariants] = useState<VariantDraft[]>([
    { ...DEFAULT_VARIANT, label: 'A' },
    { ...DEFAULT_VARIANT, label: 'B' },
  ]);

  function resetForm() {
    setKind('title');
    setMetric('views');
    setRotationHours(48);
    setRounds(1);
    setMinViews(50);
    setVariants([
      { ...DEFAULT_VARIANT, label: 'A' },
      { ...DEFAULT_VARIANT, label: 'B' },
    ]);
    setError(null);
  }

  function handleClose() {
    resetForm();
    onClose();
  }

  function addVariant() {
    if (variants.length >= 3) return;
    const nextLabel = String.fromCharCode(65 + variants.length);
    setVariants((v) => [...v, { ...DEFAULT_VARIANT, label: nextLabel }]);
  }

  function removeVariant(i: number) {
    if (variants.length <= 2) return;
    setVariants((v) => v.filter((_, j) => j !== i));
  }

  function setVariantField<K extends keyof VariantDraft>(
    i: number,
    key: K,
    value: VariantDraft[K],
  ) {
    setVariants((v) => v.map((vv, j) => (j === i ? { ...vv, [key]: value } : vv)));
  }

  function handleSubmit() {
    start(async () => {
      setError(null);
      try {
        const variantInputs = variants.map((v) => {
          const titleOpt = v.titleOptionIndex != null ? titleOptions[v.titleOptionIndex] : null;
          const thumbOpt = v.thumbnailIndex != null ? thumbnailOptions[v.thumbnailIndex] : null;
          return {
            label: v.label.trim() || undefined,
            title: titleOpt?.text ?? null,
            titleAssetId: null, // no per-variant asset id available here
            titleOptionIndex: v.titleOptionIndex ?? null,
            thumbnailAssetId: thumbOpt?.assetId ?? null,
            thumbnailPath: thumbOpt?.localPath ?? null,
          };
        });

        const input: CreateExperimentInput = {
          packageId,
          kind,
          metric,
          rotationHours,
          rounds,
          minViews,
          variants: variantInputs,
        };

        const { id } = await createExperiment(input);
        await startExperiment(id);
        router.refresh();
        handleClose();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const needsTitle = kind === 'title' || kind === 'title_thumbnail';
  const needsThumb = kind === 'thumbnail' || kind === 'title_thumbnail';

  return (
    <Modal open={open} onClose={handleClose} title="New A/B Test" maxWidth={620}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Kind */}
        <FieldRow label="Test kind">
          <div style={{ display: 'flex', gap: 6 }}>
            {(['title', 'thumbnail', 'title_thumbnail'] as const).map((k) => (
              <KindChip key={k} value={k} active={kind === k} onClick={() => setKind(k)} />
            ))}
          </div>
        </FieldRow>

        {/* Metric / rotation config */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr 1fr',
            gap: 10,
          }}
        >
          <FieldRow label="Metric">
            <FormSelect
              value={metric}
              onChange={(v) => setMetric(v as typeof metric)}
              options={[
                { value: 'views', label: 'Views' },
                { value: 'impression_ctr', label: 'Impression CTR' },
                { value: 'estimated_minutes_watched', label: 'Watch time' },
              ]}
            />
          </FieldRow>
          <FieldRow label="Rotation (hrs)">
            <FormNumber value={rotationHours} onChange={setRotationHours} min={1} max={720} />
          </FieldRow>
          <FieldRow label="Rounds">
            <FormNumber value={rounds} onChange={setRounds} min={1} max={5} />
          </FieldRow>
          <FieldRow label="Min views">
            <FormNumber value={minViews} onChange={setMinViews} min={0} max={1000000} />
          </FieldRow>
        </div>

        {/* Variants */}
        <div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <Eyebrow>Variants</Eyebrow>
            {variants.length < 3 && (
              <button
                type="button"
                onClick={addVariant}
                style={{
                  fontSize: 11,
                  color: 'var(--accent)',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-mono)',
                }}
              >
                + add variant
              </button>
            )}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {variants.map((v, i) => (
              <VariantEditor
                key={`variant-${String.fromCharCode(65 + i)}`}
                index={i}
                draft={v}
                canRemove={variants.length > 2}
                needsTitle={needsTitle}
                needsThumb={needsThumb}
                titleOptions={titleOptions}
                thumbnailOptions={thumbnailOptions}
                onChange={(key, value) => setVariantField(i, key, value)}
                onRemove={() => removeVariant(i)}
              />
            ))}
          </div>
        </div>

        {/* Error */}
        {error && (
          <div
            style={{
              padding: '8px 10px',
              fontSize: 12,
              color: 'var(--status-failed)',
              background: 'color-mix(in oklab, var(--status-failed) 8%, transparent)',
              border: '1px solid color-mix(in oklab, var(--status-failed) 28%, transparent)',
              borderRadius: 6,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, paddingTop: 4 }}>
          <GhostBtn size="sm" onClick={handleClose} disabled={pending}>
            Cancel
          </GhostBtn>
          <PrimaryBtn size="sm" icon="▶" loading={pending} onClick={handleSubmit}>
            Create &amp; start
          </PrimaryBtn>
        </div>
      </div>
    </Modal>
  );
}

// ─── Variant editor row ───────────────────────────────────────────────────────

function VariantEditor({
  index,
  draft,
  canRemove,
  needsTitle,
  needsThumb,
  titleOptions,
  thumbnailOptions,
  onChange,
  onRemove,
}: {
  index: number;
  draft: VariantDraft;
  canRemove: boolean;
  needsTitle: boolean;
  needsThumb: boolean;
  titleOptions: ExperimentTitleOption[];
  thumbnailOptions: ExperimentThumbnailOption[];
  onChange: <K extends keyof VariantDraft>(key: K, value: VariantDraft[K]) => void;
  onRemove: () => void;
}) {
  return (
    <div
      style={{
        background: 'var(--bg-elev-2)',
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
        <span
          style={{
            width: 22,
            height: 22,
            borderRadius: 5,
            background: 'var(--bg-elev)',
            border: '1px solid var(--border)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 11,
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
          }}
        >
          {String.fromCharCode(65 + index)}
        </span>
        <input
          placeholder="Label (optional)"
          value={draft.label}
          onChange={(e) => onChange('label', e.target.value)}
          style={inputStyle}
        />
        {canRemove && (
          <button
            type="button"
            onClick={onRemove}
            style={{
              fontSize: 14,
              color: 'var(--text-faint)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              lineHeight: 1,
              padding: '0 2px',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* Title picker */}
      {needsTitle && (
        <div style={{ marginBottom: needsThumb ? 8 : 0 }}>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 4 }}>Title</div>
          <FormSelect
            value={draft.titleOptionIndex != null ? String(draft.titleOptionIndex) : ''}
            onChange={(v) => onChange('titleOptionIndex', v !== '' ? Number(v) : null)}
            options={[
              {
                value: '',
                label:
                  titleOptions.length === 0 ? 'No title options available' : '— pick a title —',
              },
              ...titleOptions.map((t, i) => ({
                value: String(i),
                label: `${t.text.slice(0, 60)}${t.text.length > 60 ? '…' : ''}${t.score != null ? ` [${t.score}]` : ''}`,
              })),
            ]}
          />
        </div>
      )}

      {/* Thumbnail picker */}
      {needsThumb && (
        <div>
          <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>Thumbnail</div>
          {thumbnailOptions.length === 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
              No thumbnails available — generate them first.
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
                gap: 6,
              }}
            >
              {thumbnailOptions.map((t, i) => {
                const selected = draft.thumbnailIndex === i;
                return (
                  <button
                    key={t.assetId}
                    type="button"
                    onClick={() => onChange('thumbnailIndex', selected ? null : i)}
                    style={{
                      position: 'relative',
                      aspectRatio: '16/9',
                      borderRadius: 5,
                      overflow: 'hidden',
                      border: `2px solid ${selected ? 'var(--accent)' : 'var(--border)'}`,
                      cursor: 'pointer',
                      padding: 0,
                      background: 'var(--bg-elev)',
                    }}
                  >
                    {t.mediaUrl ? (
                      <img
                        src={t.mediaUrl}
                        alt=""
                        style={{
                          width: '100%',
                          height: '100%',
                          objectFit: 'cover',
                          display: 'block',
                        }}
                      />
                    ) : (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 9,
                          color: 'var(--text-faint)',
                        }}
                      >
                        no img
                      </div>
                    )}
                    {selected && (
                      <div
                        style={{
                          position: 'absolute',
                          inset: 0,
                          background: 'color-mix(in oklab, var(--accent) 18%, transparent)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                      >
                        <span style={{ fontSize: 14, color: 'var(--accent)' }}>✓</span>
                      </div>
                    )}
                    {t.rank != null && (
                      <span
                        style={{
                          position: 'absolute',
                          bottom: 2,
                          right: 3,
                          fontSize: 8,
                          fontFamily: 'var(--font-mono)',
                          color: '#fff',
                          background: 'rgba(0,0,0,0.55)',
                          padding: '0 3px',
                          borderRadius: 2,
                        }}
                      >
                        #{t.rank}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Small form primitives ────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  padding: '5px 8px',
  fontSize: 12,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  outline: 'none',
  color: 'var(--text)',
};

function FieldRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{label}</div>
      {children}
    </div>
  );
}

function FormSelect({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        width: '100%',
        padding: '5px 8px',
        fontSize: 12,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        color: 'var(--text)',
        outline: 'none',
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function FormNumber({
  value,
  onChange,
  min,
  max,
}: {
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
}) {
  return (
    <input
      type="number"
      value={value}
      min={min}
      max={max}
      onChange={(e) => onChange(Number(e.target.value))}
      style={{
        width: '100%',
        padding: '5px 8px',
        fontSize: 12,
        background: 'var(--bg)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        color: 'var(--text)',
        outline: 'none',
      }}
    />
  );
}

function KindChip({
  value,
  active,
  onClick,
}: {
  value: 'title' | 'thumbnail' | 'title_thumbnail';
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        padding: '5px 10px',
        fontSize: 12,
        fontWeight: active ? 600 : 400,
        color: active ? '#fff' : 'var(--text-muted)',
        background: active ? 'var(--accent)' : 'var(--bg-elev)',
        border: `1px solid ${active ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 6,
        cursor: 'pointer',
        transition: 'all 0.1s',
      }}
    >
      {kindLabel(value)}
    </button>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function kindLabel(kind: string): string {
  if (kind === 'title') return 'Title';
  if (kind === 'thumbnail') return 'Thumbnail';
  if (kind === 'title_thumbnail') return 'Title + Thumbnail';
  return kind;
}

function metricLabel(metric: string): string {
  if (metric === 'views') return 'Views';
  if (metric === 'impression_ctr') return 'Impression CTR';
  if (metric === 'estimated_minutes_watched') return 'Watch time';
  return metric;
}

function variantLabel(exp: ExperimentRow, variantIndex: number): string {
  return exp.variants[variantIndex]?.label ?? String(variantIndex);
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
