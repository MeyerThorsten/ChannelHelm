/**
 * /performance — cross-surface performance dashboard.
 *
 * Data strategy:
 *   - Brand summaries: aggregate signals + published-asset counts via Drizzle.
 *   - Per-asset metrics: assets.signals JSONB snapshot (fast path). Only assets
 *     in status dispatched|published, joined to packages + brands for context.
 *   - Experiments: experiments table filtered to status='decided', joined to
 *     packages. Winner scores are derived from variants[winnerVariant].observations
 *     using the same scoreVariant() helper as the experiment_tick worker.
 *
 * No raw pg, no writes, no schema changes.
 */

import { AssetTable } from '@/components/performance/AssetTable';
import { ExperimentsResults } from '@/components/performance/ExperimentsResults';
import { SummaryStrip } from '@/components/performance/SummaryStrip';
import type {
  AssetSignals,
  BrandSummary,
  ExperimentDecisionResult,
  PerformanceAsset,
} from '@/components/performance/types';
import { Eyebrow } from '@/components/ui';
import { db } from '@/db/client';
import { assets, brands, experiments, packages, signals, sources } from '@/db/schema';
import type { ExperimentVariant } from '@/db/schema/experiments';
import { scoreVariant } from '@/lib/ab-decision';
import type { DecisionMetric } from '@/lib/ab-decision';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

const DISPATCHED_STATUSES = ['dispatched', 'published'];

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse assets.signals JSONB snapshot into a typed shape.
 * Both Zernio and YouTube paths use different keys; we handle both.
 */
function parseSignals(raw: Record<string, unknown> | null): AssetSignals {
  if (!raw) {
    return {
      views: null,
      impressions: null,
      engagement: null,
      ctr: null,
      avgViewPct: null,
      lastSampledAt: null,
    };
  }
  const num = (k: string): number | null => {
    const v = raw[k];
    return typeof v === 'number' ? v : null;
  };
  const str = (k: string): string | null => {
    const v = raw[k];
    return typeof v === 'string' ? v : null;
  };

  // YouTube path keys: views, avg_view_pct, impression_ctr, last_sampled_at
  // Zernio path keys:  impressions, engagement, ctr, last_sampled_at
  return {
    views: num('views'),
    impressions: num('impressions'),
    engagement: num('engagement'),
    ctr: num('ctr') ?? num('impression_ctr'),
    avgViewPct: num('avg_view_pct'),
    lastSampledAt: str('last_sampled_at'),
  };
}

/** Derive the platform string from dispatch.target */
function platformFromDispatch(dispatch: Record<string, unknown> | null): string | null {
  if (!dispatch) return null;
  const target = typeof dispatch.target === 'string' ? dispatch.target : null;
  if (!target) return null;
  // youtube_direct → youtube, manual → null (no analytics), everything else verbatim
  if (target === 'youtube_direct') return 'youtube';
  if (target === 'manual') return null;
  return target;
}

function externalIdFromDispatch(dispatch: Record<string, unknown> | null): string | null {
  if (!dispatch) return null;
  const v = dispatch.external_id ?? dispatch.video_id;
  return typeof v === 'string' ? v : null;
}

// ─── data fetchers ────────────────────────────────────────────────────────────

async function fetchBrandSummaries(): Promise<BrandSummary[]> {
  const brandRows = await db
    .select({ id: brands.id, slug: brands.slug, name: brands.name })
    .from(brands)
    .where(eq(brands.active, true))
    .orderBy(brands.slug);

  if (brandRows.length === 0) return [];

  const brandIds = brandRows.map((b) => b.id);

  // Published asset counts per brand
  const publishedCounts = await db
    .select({
      brandId: assets.brandId,
      count: sql<number>`count(*)::int`,
    })
    .from(assets)
    .where(and(inArray(assets.brandId, brandIds), inArray(assets.status, DISPATCHED_STATUSES)))
    .groupBy(assets.brandId);
  const countMap = new Map(publishedCounts.map((r) => [r.brandId, r.count]));

  // Aggregate signals per brand: avg CTR, avg avg_view_pct, sum views+impressions
  // using the latest sample per (asset_id, metric) — mirrors promote_voice_examples pattern
  const aggRows = await db.execute(sql`
    WITH latest AS (
      SELECT brand_id, asset_id, metric, value,
             row_number() OVER (PARTITION BY asset_id, metric ORDER BY sampled_at DESC) AS rn
        FROM signals
       WHERE brand_id IN (${sql.join(
         brandIds.map((id) => sql`${id}`),
         sql`, `,
       )})
    ),
    per_asset AS (
      SELECT brand_id,
             max(CASE WHEN metric = 'ctr'           THEN value END) AS ctr,
             max(CASE WHEN metric = 'avg_view_pct'  THEN value END) AS avg_view_pct,
             max(CASE WHEN metric = 'views'         THEN value END) AS views,
             max(CASE WHEN metric = 'impressions'   THEN value END) AS impressions
        FROM latest
       WHERE rn = 1
       GROUP BY brand_id, asset_id
    )
    SELECT brand_id,
           avg(ctr)           AS avg_ctr,
           avg(avg_view_pct)  AS avg_view_pct,
           sum(COALESCE(views, impressions)) AS total_reach
      FROM per_asset
     GROUP BY brand_id
  `);

  const aggMap = new Map<
    string,
    { avgCtr: number | null; avgViewPct: number | null; totalReach: number | null }
  >();
  // node-postgres returns .rows on execute
  const aggData =
    (
      aggRows as unknown as {
        rows: Array<{
          brand_id: string;
          avg_ctr: string | null;
          avg_view_pct: string | null;
          total_reach: string | null;
        }>;
      }
    ).rows ?? [];
  for (const row of aggData) {
    aggMap.set(row.brand_id, {
      avgCtr: row.avg_ctr != null ? Number(row.avg_ctr) : null,
      avgViewPct: row.avg_view_pct != null ? Number(row.avg_view_pct) : null,
      totalReach: row.total_reach != null ? Number(row.total_reach) : null,
    });
  }

  return brandRows.map((b) => {
    const agg = aggMap.get(b.id);
    return {
      id: b.id,
      slug: b.slug,
      name: b.name,
      publishedCount: countMap.get(b.id) ?? 0,
      avgCtr: agg?.avgCtr ?? null,
      avgViewPct: agg?.avgViewPct ?? null,
      totalReach: agg?.totalReach ?? null,
    } satisfies BrandSummary;
  });
}

async function fetchPerformanceAssets(): Promise<PerformanceAsset[]> {
  const rows = await db
    .select({
      asset: assets,
      pkgId: packages.id,
      pkgTitle: sources.title,
      pkgOriginUrl: sources.originUrl,
      brandSlug: brands.slug,
      brandName: brands.name,
    })
    .from(assets)
    .innerJoin(packages, eq(packages.id, assets.packageId))
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .innerJoin(brands, eq(brands.id, assets.brandId))
    .where(inArray(assets.status, DISPATCHED_STATUSES))
    .orderBy(desc(assets.updatedAt))
    .limit(60);

  return rows.map(({ asset, pkgId, pkgTitle, pkgOriginUrl, brandSlug, brandName }) => {
    const dispatch = (asset.dispatch ?? null) as Record<string, unknown> | null;
    const signalsRaw = (asset.signals ?? null) as Record<string, unknown> | null;
    return {
      id: asset.id,
      packageId: pkgId,
      packageTitle: pkgTitle ?? pkgOriginUrl ?? pkgId,
      type: asset.type,
      status: asset.status,
      platform: platformFromDispatch(dispatch),
      externalId: externalIdFromDispatch(dispatch),
      signals: parseSignals(signalsRaw),
      updatedAt: asset.updatedAt.toISOString(),
      brandId: asset.brandId,
      brandSlug,
      brandName,
    } satisfies PerformanceAsset;
  });
}

async function fetchDecidedExperiments(): Promise<ExperimentDecisionResult[]> {
  const rows = await db
    .select({
      exp: experiments,
      pkgTitle: sources.title,
      pkgOriginUrl: sources.originUrl,
    })
    .from(experiments)
    .innerJoin(packages, eq(packages.id, experiments.packageId))
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .where(eq(experiments.status, 'decided'))
    .orderBy(desc(experiments.decidedAt))
    .limit(24);

  return rows.map(({ exp, pkgTitle, pkgOriginUrl }) => {
    const variants: ExperimentVariant[] = (exp.variants ?? []) as ExperimentVariant[];
    const metric = (exp.metric ?? 'views') as DecisionMetric;
    const winnerIdx = exp.winnerVariant;

    const variantScores = variants.map((v) => {
      const scored = scoreVariant(v, metric);
      return {
        label: v.label,
        score: scored.score,
        totalViews: scored.totalViews,
      };
    });

    const winner = winnerIdx != null ? variants[winnerIdx] : null;
    const winnerScored = winner ? scoreVariant(winner, metric) : null;

    return {
      id: exp.id,
      packageId: exp.packageId,
      packageTitle: pkgTitle ?? pkgOriginUrl ?? exp.packageId,
      kind: exp.kind,
      metric: exp.metric,
      winnerLabel: winner?.label ?? null,
      winnerScore: winnerScored?.score ?? null,
      decidedAt: exp.decidedAt?.toISOString() ?? null,
      variants: variantScores,
    } satisfies ExperimentDecisionResult;
  });
}

// ─── page ──────────────────────────────────────────────────────────────────────

export default async function PerformancePage() {
  const [brandSummaries, performanceAssets, decidedExperiments] = await Promise.all([
    fetchBrandSummaries(),
    fetchPerformanceAssets(),
    fetchDecidedExperiments(),
  ]);

  const hasAnyData =
    brandSummaries.some((b) => b.publishedCount > 0) ||
    performanceAssets.length > 0 ||
    decidedExperiments.length > 0;

  // Count assets with actual signal data (non-empty signals snapshot)
  const assetsWithSignals = performanceAssets.filter((a) => {
    const s = a.signals;
    return (
      s.views != null ||
      s.impressions != null ||
      s.engagement != null ||
      s.ctr != null ||
      s.avgViewPct != null
    );
  });

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 32px 80px' }}>
      {/* Page header */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 4 }}>
        <Eyebrow>Performance</Eyebrow>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          {assetsWithSignals.length} asset{assetsWithSignals.length === 1 ? '' : 's'} with signals
          {decidedExperiments.length > 0 &&
            ` · ${decidedExperiments.length} A/B result${decidedExperiments.length === 1 ? '' : 's'}`}
        </span>
      </div>
      <h1
        className="serif"
        style={{
          fontSize: 44,
          fontWeight: 400,
          margin: '4px 0 6px',
          letterSpacing: -0.5,
          lineHeight: 1.05,
        }}
      >
        How it performed.
        <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>
          {' '}
          Across every surface.
        </span>
      </h1>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 36px', maxWidth: 580 }}>
        Published metrics from YouTube, Zernio, and DojoClaw — aggregated from signal collection
        runs. Data refreshes as the{' '}
        <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>collect_signal</code> worker
        runs.
      </p>

      {!hasAnyData ? (
        /* Full-page empty state — fresh install */
        <div
          style={{
            borderRadius: 12,
            border: '1px dashed var(--border)',
            padding: '64px 48px',
            textAlign: 'center',
            color: 'var(--text-faint)',
            lineHeight: 1.7,
          }}
        >
          <div style={{ fontSize: 36, marginBottom: 12 }}>📡</div>
          <div
            style={{ fontSize: 16, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 8 }}
          >
            No performance data yet.
          </div>
          <div style={{ fontSize: 13, maxWidth: 440, margin: '0 auto' }}>
            Ingest a video, run the full pipeline, approve and dispatch assets. Once the{' '}
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>collect_signal</code>{' '}
            recurring job fires, metrics will appear here — views, CTR, retention, and A/B results.
          </div>
        </div>
      ) : (
        <>
          {/* Brand-level summary cards */}
          <SummaryStrip brands={brandSummaries} />

          {/* Asset metrics table */}
          <AssetTable assets={performanceAssets} />

          {/* A/B experiment results */}
          <ExperimentsResults experiments={decidedExperiments} />
        </>
      )}
    </main>
  );
}
