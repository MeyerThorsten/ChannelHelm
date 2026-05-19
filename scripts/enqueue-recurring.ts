/**
 * Enqueue the recurring maintenance jobs:
 *
 *   - collect_signal           — for every published asset that was last
 *                                sampled more than `--stale-hours` ago
 *                                (default 6), or never sampled.
 *   - promote_voice_examples   — once per (brand, asset_type) pair where
 *                                signals exist.
 *
 * Idempotency keys (per §4):
 *   collect_signal: `collect_signal:{asset_id}:{window_start_iso}` where
 *                   window_start is the previous-multiple-of-stale-hours
 *                   boundary, so two consecutive runs within the same
 *                   window produce a single job.
 *   promote_voice_examples: `promote_voice_examples:{brand_id}:{type}:{day_iso}`
 *                   — at most once per (brand, type, calendar day).
 *
 * Wire this into `launchd` via the plist at
 * `infra/launchd/com.channelhelm.recurring.plist` (StartInterval=900 →
 * runs every 15 minutes).
 *
 * Run manually:
 *   tsx scripts/enqueue-recurring.ts [--stale-hours 6]
 */
import 'dotenv/config';
import { db } from '@/db/client';
import { assets, signals } from '@/db/schema';
import { enqueue } from '@workers/queue';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const staleHours = Number.parseInt(args[args.indexOf('--stale-hours') + 1] ?? '6', 10);

  const windowMs = staleHours * 60 * 60 * 1000;
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / windowMs) * windowMs).toISOString();
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  // ─── collect_signal — assets that need a fresh analytics pull ────────────
  const staleAssets = await db
    .select({ id: assets.id, brandId: assets.brandId, type: assets.type })
    .from(assets)
    .where(
      and(
        eq(assets.status, 'published'),
        sql`(${assets.dispatch} ->> 'target') = 'zernio'`,
        or(
          isNull(sql`${assets.signals} ->> 'last_sampled_at'`),
          lt(
            sql`(${assets.signals} ->> 'last_sampled_at')::timestamptz`,
            sql`now() - (interval '1 hour') * ${staleHours}`,
          ),
        ),
      ),
    );

  let collectEnqueued = 0;
  let collectSkipped = 0;
  for (const a of staleAssets) {
    const r = await enqueue({
      kind: 'collect_signal',
      payload: { assetId: a.id },
      idempotencyKey: `collect_signal:${a.id}:${windowStart}`,
    });
    if (r.created) collectEnqueued++;
    else collectSkipped++;
  }
  console.log(
    `[enqueue-recurring] collect_signal: ${collectEnqueued} new, ${collectSkipped} dedup ` +
      `(window_start=${windowStart}, stale_hours=${staleHours})`,
  );

  // ─── promote_voice_examples — once per (brand, asset_type) per day ────────
  const pairs = await db
    .select({ brandId: signals.brandId, assetType: assets.type })
    .from(signals)
    .innerJoin(assets, eq(assets.id, signals.assetId))
    .groupBy(signals.brandId, assets.type);

  let voiceEnqueued = 0;
  let voiceSkipped = 0;
  for (const p of pairs) {
    const r = await enqueue({
      kind: 'promote_voice_examples',
      payload: { brandId: p.brandId, assetType: p.assetType },
      idempotencyKey: `promote_voice_examples:${p.brandId}:${p.assetType}:${today}`,
    });
    if (r.created) voiceEnqueued++;
    else voiceSkipped++;
  }
  console.log(
    `[enqueue-recurring] promote_voice_examples: ${voiceEnqueued} new, ${voiceSkipped} dedup ` +
      `(day=${today})`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[enqueue-recurring] fatal:', err);
    process.exit(1);
  });
