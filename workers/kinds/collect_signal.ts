import { db } from '@/db/client';
import { assets, packages, signals } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { fetchVideoAnalytics } from '../integrations/youtube';
import { fetchAnalytics } from '../integrations/zernio';
import type { JobRow } from '../queue';

type AssetRow = typeof assets.$inferSelect;

const redirectUri = (): string =>
  `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}/api/youtube/oauth/callback`;
const isoDate = (d: Date): string => d.toISOString().slice(0, 10);
const clamp01 = (n: number): number => Math.max(0, Math.min(1, n));

const Payload = z.object({
  assetId: z.string().regex(/^ast_/),
  windowStartIso: z.string().datetime().optional(),
});

/**
 * §13 step 16. Pulls analytics for one dispatched asset and writes per-metric
 * rows into the `signals` table.
 *
 * v1 only collects from Zernio (the only external dispatcher with an
 * analytics API). DojoClaw doesn't expose per-article metrics yet; YouTube
 * needs the YouTube Data API + OAuth which is separately gated.
 *
 * Idempotency: re-running for the same `(asset_id, window_start_iso)` will
 * append fresh rows (sampled_at is per-call) — duplicate jobs are prevented
 * upstream via the idempotency key `collect_signal:{asset_id}:{window}`.
 */
export async function run(job: JobRow): Promise<void> {
  const { assetId } = Payload.parse(job.payload);

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`collect_signal: asset ${assetId} not found`);

  const dispatch = (asset.dispatch ?? {}) as {
    target?: string;
    external_id?: string | null;
    video_id?: string | null;
  };

  // YouTube Direct: pull real retention (averageViewPercentage) + views/CTR
  // from the Analytics API. Feeds the dashboard AND the F3 retention calibration.
  if (dispatch.target === 'youtube_direct') {
    await collectYoutube(asset, dispatch.video_id ?? dispatch.external_id ?? null);
    return;
  }

  if (dispatch.target !== 'zernio' || !dispatch.external_id) {
    console.log(
      `[collect_signal] asset=${assetId} not dispatched via zernio/youtube (target=${dispatch.target ?? 'none'}), skipping`,
    );
    return;
  }

  console.log(`[collect_signal] asset=${assetId} zernio=${dispatch.external_id}`);
  const analytics = await fetchAnalytics(dispatch.external_id);

  const sampledAt = new Date(analytics.last_sampled_at);
  const rows = [
    { metric: 'impressions', value: analytics.impressions },
    { metric: 'engagement', value: analytics.engagement },
    ...(analytics.ctr != null ? [{ metric: 'ctr', value: analytics.ctr }] : []),
  ];
  for (const r of rows) {
    await db.insert(signals).values({
      brandId: asset.brandId,
      assetId,
      sourceSignal: 'zernio',
      metric: r.metric,
      value: r.value,
      sampledAt,
    });
  }

  // Mirror the latest snapshot into asset.signals for fast dashboard reads.
  await db
    .update(assets)
    .set({
      signals: {
        impressions: analytics.impressions,
        engagement: analytics.engagement,
        ctr: analytics.ctr,
        last_sampled_at: analytics.last_sampled_at,
      },
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, assetId));
}

/**
 * YouTube Direct analytics → signals. Writes views, CTR, and the measured
 * average view fraction; when the package carries a predicted retention
 * fraction (from analyze_intelligence), also writes a paired `retention_sample`
 * row (value = actual, metadata.predicted) that trains the F3 calibration.
 */
async function collectYoutube(asset: AssetRow, videoId: string | null): Promise<void> {
  if (!videoId) {
    console.log(`[collect_signal] asset=${asset.id} youtube_direct but no video id, skipping`);
    return;
  }
  const end = new Date();
  const start = new Date(end.getTime() - 365 * 86_400_000);
  let a: Awaited<ReturnType<typeof fetchVideoAnalytics>>;
  try {
    a = await fetchVideoAnalytics({
      brandId: asset.brandId,
      redirectUri: redirectUri(),
      videoId,
      startDate: isoDate(start),
      endDate: isoDate(end),
    });
  } catch (err) {
    // Missing analytics scope or transient API errors shouldn't fail the job.
    console.warn(
      `[collect_signal] youtube analytics failed for ${asset.id}: ${(err as Error).message}`,
    );
    return;
  }

  const sampledAt = new Date();
  const actualFraction =
    a.averageViewPercentage != null ? clamp01(a.averageViewPercentage / 100) : null;
  const base = { brandId: asset.brandId, assetId: asset.id, sourceSignal: 'youtube', sampledAt };

  await db.insert(signals).values({ ...base, metric: 'views', value: a.views });
  if (a.impressionCtr != null) {
    await db.insert(signals).values({ ...base, metric: 'ctr', value: a.impressionCtr });
  }
  if (actualFraction != null) {
    await db.insert(signals).values({ ...base, metric: 'avg_view_pct', value: actualFraction });
    const predicted = await predictedFractionForPackage(asset.packageId);
    if (predicted != null) {
      await db.insert(signals).values({
        ...base,
        metric: 'retention_sample',
        value: actualFraction,
        metadata: { predicted },
      });
    }
  }

  await db
    .update(assets)
    .set({
      signals: {
        views: a.views,
        avg_view_pct: actualFraction,
        impression_ctr: a.impressionCtr,
        last_sampled_at: sampledAt.toISOString(),
      },
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, asset.id));

  console.log(
    `[collect_signal] asset=${asset.id} youtube=${videoId} views=${a.views} avp=${actualFraction ?? 'n/a'}`,
  );
}

/** The predicted retention fraction stored on a package by analyze_intelligence. */
async function predictedFractionForPackage(packageId: string): Promise<number | null> {
  const [pkg] = await db
    .select({ intel: packages.intelligence })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  const pf = (pkg?.intel as { analysis?: { retention?: { predicted_fraction?: unknown } } } | null)
    ?.analysis?.retention?.predicted_fraction;
  return typeof pf === 'number' ? pf : null;
}
