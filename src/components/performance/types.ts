/**
 * Shared types for the /performance route.
 * Kept as a plain TS file (no DB imports) so sub-components can import it
 * without pulling the Drizzle client into the client bundle.
 */

export type BrandSummary = {
  id: string;
  slug: string;
  name: string;
  /** Number of assets in status dispatched|published */
  publishedCount: number;
  /** Average CTR across all signals, null when no CTR data */
  avgCtr: number | null;
  /** Average avg_view_pct across all signals, null when no data */
  avgViewPct: number | null;
  /** Total views (YouTube) or impressions (Zernio) */
  totalReach: number | null;
};

export type AssetSignals = {
  views: number | null;
  impressions: number | null;
  engagement: number | null;
  ctr: number | null;
  avgViewPct: number | null;
  lastSampledAt: string | null;
};

export type PerformanceAsset = {
  id: string;
  packageId: string;
  packageTitle: string;
  type: string;
  status: string;
  /** Derived from dispatch.target */
  platform: string | null;
  /** Derived from dispatch.external_id */
  externalId: string | null;
  signals: AssetSignals;
  updatedAt: string;
  brandId: string;
  brandSlug: string;
  brandName: string;
};

export type ExperimentDecisionResult = {
  id: string;
  packageId: string;
  packageTitle: string;
  kind: string;
  metric: string;
  winnerLabel: string | null;
  winnerScore: number | null;
  decidedAt: string | null;
  variants: Array<{
    label: string;
    score: number | null;
    totalViews: number;
  }>;
};
