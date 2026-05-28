/**
 * Enqueue the recurring maintenance jobs:
 *
 *   - collect_signal           — for every published asset that was last
 *                                sampled more than `--stale-hours` ago
 *                                (default 6), or never sampled.
 *   - promote_voice_examples   — once per (brand, asset_type) pair where
 *                                signals exist.
 *   - archive_package          — Option B / storage lifecycle. For every
 *                                published package whose latest dispatch
 *                                is older than ARCHIVE_AFTER_DAYS (default
 *                                14) and which hasn't been archived yet.
 *                                Skipped entirely when ARCHIVE_ROOT is
 *                                unset (feature off).
 *
 * Idempotency keys (per §4):
 *   collect_signal: `collect_signal:{asset_id}:{window_start_iso}` where
 *                   window_start is the previous-multiple-of-stale-hours
 *                   boundary, so two consecutive runs within the same
 *                   window produce a single job.
 *   promote_voice_examples: `promote_voice_examples:{brand_id}:{type}:{day_iso}`
 *                   — at most once per (brand, type, calendar day).
 *   archive_package: `archive_package:{package_id}` — at most one archive
 *                   per package ever.
 *
 * Wire this into `launchd` via the plist at
 * `infra/launchd/com.channelhelm.recurring.plist` (StartInterval=900 →
 * runs every 15 minutes).
 *
 * Run manually:
 *   tsx scripts/enqueue-recurring.ts [--stale-hours 6] [--archive-after-days 14]
 */
import 'dotenv/config';
import { db } from '@/db/client';
import { assets, dispatches, packages, signals } from '@/db/schema';
import { loadSettingsIntoEnv } from '@/lib/settings';
import { enqueue } from '@workers/queue';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';

async function main(): Promise<void> {
  // Hydrate DB-backed settings into process.env so values edited via
  // /settings (ARCHIVE_AFTER_DAYS, ARCHIVE_ROOT) are reflected here.
  // Tolerate failure — fresh checkouts may not have the settings table yet.
  try {
    await loadSettingsIntoEnv();
  } catch (err) {
    console.warn('[enqueue-recurring] settings hydration skipped:', (err as Error).message);
  }

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

  // ─── archive_package — Option B / storage lifecycle ───────────────────────
  const archiveRoot = (process.env.ARCHIVE_ROOT ?? '').trim();
  if (!archiveRoot) {
    console.log('[enqueue-recurring] archive_package: ARCHIVE_ROOT unset — feature disabled');
  } else {
    const flagIdx = args.indexOf('--archive-after-days');
    const archiveAfterDays = Number.parseInt(
      args[flagIdx + 1] ?? process.env.ARCHIVE_AFTER_DAYS ?? '14',
      10,
    );
    if (!Number.isFinite(archiveAfterDays) || archiveAfterDays < 1) {
      console.warn(
        `[enqueue-recurring] archive_package: invalid ARCHIVE_AFTER_DAYS=${archiveAfterDays}, skipping`,
      );
    } else {
      // Eligible: package not yet archived, has at least one successful
      // dispatch, and the LATEST successful dispatch is older than the
      // configured cutoff. One row per package_id.
      const eligible = await db
        .select({ packageId: packages.id })
        .from(packages)
        .innerJoin(assets, eq(assets.packageId, packages.id))
        .innerJoin(dispatches, eq(dispatches.assetId, assets.id))
        .where(and(isNull(packages.archivedAt), eq(dispatches.success, true)))
        .groupBy(packages.id)
        .having(
          sql`MAX(${dispatches.dispatchedAt}) < now() - (interval '1 day') * ${archiveAfterDays}`,
        );

      let archiveEnqueued = 0;
      let archiveSkipped = 0;
      for (const e of eligible) {
        const r = await enqueue({
          kind: 'archive_package',
          payload: { packageId: e.packageId },
          idempotencyKey: `archive_package:${e.packageId}`,
        });
        if (r.created) archiveEnqueued++;
        else archiveSkipped++;
      }
      console.log(
        `[enqueue-recurring] archive_package: ${archiveEnqueued} new, ${archiveSkipped} dedup ` +
          `(after_days=${archiveAfterDays}, root=${archiveRoot})`,
      );
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[enqueue-recurring] fatal:', err);
    process.exit(1);
  });
