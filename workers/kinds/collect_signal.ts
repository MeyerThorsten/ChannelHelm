import { db } from '@/db/client';
import { assets, signals } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { fetchAnalytics } from '../integrations/zernio';
import type { JobRow } from '../queue';

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

  const dispatch = (asset.dispatch ?? {}) as { target?: string; external_id?: string | null };
  if (dispatch.target !== 'zernio' || !dispatch.external_id) {
    console.log(
      `[collect_signal] asset=${assetId} not dispatched via zernio (target=${dispatch.target ?? 'none'}), skipping`,
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
