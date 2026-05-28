/**
 * Backfill rendered_short_clip MP4s for every existing short_clip_plan that
 * has missing or partial renders. Mirrors the approveAsset / approvePackage
 * pattern (`clip_render:${planAssetId}:${clipIndex}` idempotency key, no rev
 * suffix), so re-running the script is a true no-op once everything is
 * enqueued — the queue dedupes on the key.
 *
 * Per-clip eligibility:
 *   - clip exists in plan.payload.clips[i]
 *   - AND no rendered_short_clip exists with payload.plan_asset_id = plan.id
 *     AND payload.clip_index = i
 *   (When --force is passed, ALL clips are enqueued regardless of existing
 *    renders. The clip_render worker's render_rev skip still protects against
 *    pointless re-encodes when render_rev hasn't moved.)
 *
 * Long-form clips (long_clip_plan → rendered_long_clip) are included by
 * default because clip_render handles both. Restrict with --type if needed.
 *
 * Run manually:
 *   tsx scripts/render-shorts.ts                       # all packages, missing clips only
 *   tsx scripts/render-shorts.ts --package-id pkg_xxx  # one package
 *   tsx scripts/render-shorts.ts --brand-id brd_xxx    # one brand
 *   tsx scripts/render-shorts.ts --type short_clip_plan
 *   tsx scripts/render-shorts.ts --dry-run             # show plan, enqueue nothing
 *   tsx scripts/render-shorts.ts --force               # enqueue every clip even if already rendered
 */
import 'dotenv/config';
import { db } from '@/db/client';
import { assets } from '@/db/schema';
import { loadSettingsIntoEnv } from '@/lib/settings';
import { enqueue } from '@workers/queue';
import { and, eq, inArray, sql } from 'drizzle-orm';

type PlanType = 'short_clip_plan' | 'long_clip_plan';
const ALL_PLAN_TYPES: PlanType[] = ['short_clip_plan', 'long_clip_plan'];
const RENDERED_FOR: Record<PlanType, string> = {
  short_clip_plan: 'rendered_short_clip',
  long_clip_plan: 'rendered_long_clip',
};

function parseArgs(argv: string[]): {
  packageId: string | null;
  brandId: string | null;
  type: PlanType[] | null;
  dryRun: boolean;
  force: boolean;
} {
  let packageId: string | null = null;
  let brandId: string | null = null;
  let type: PlanType[] | null = null;
  let dryRun = false;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--package-id') packageId = argv[++i] ?? null;
    else if (flag === '--brand-id') brandId = argv[++i] ?? null;
    else if (flag === '--type') {
      const v = argv[++i];
      if (v === 'short_clip_plan' || v === 'long_clip_plan') type = [v];
    } else if (flag === '--dry-run') dryRun = true;
    else if (flag === '--force') force = true;
  }
  return { packageId, brandId, type, dryRun, force };
}

async function main(): Promise<void> {
  try {
    await loadSettingsIntoEnv();
  } catch (err) {
    console.warn('[render-shorts] settings hydration skipped:', (err as Error).message);
  }

  const args = parseArgs(process.argv.slice(2));
  const planTypes = args.type ?? ALL_PLAN_TYPES;

  const filters = [inArray(assets.type, planTypes)];
  if (args.packageId) filters.push(eq(assets.packageId, args.packageId));
  if (args.brandId) filters.push(eq(assets.brandId, args.brandId));

  const plans = await db
    .select({ id: assets.id, type: assets.type, packageId: assets.packageId, payload: assets.payload })
    .from(assets)
    .where(and(...filters));

  console.log(
    `[render-shorts] found ${plans.length} plan(s) ` +
      `(types=${planTypes.join(',')}` +
      `${args.packageId ? `, package=${args.packageId}` : ''}` +
      `${args.brandId ? `, brand=${args.brandId}` : ''})`,
  );

  let planCount = 0;
  let totalEnqueued = 0;
  let totalSkipped = 0;
  let totalAlreadyRendered = 0;

  for (const plan of plans) {
    const planType = plan.type as PlanType;
    const clips = ((plan.payload as { clips?: unknown[] } | null)?.clips ?? []) as unknown[];
    if (clips.length === 0) {
      console.log(`[render-shorts]   ${plan.id} (${planType}, pkg=${plan.packageId}): no clips, skipping`);
      continue;
    }

    // One query per plan: which rendered indices already exist? Cheap because
    // `assets` is keyed by package_id and the predicate hits a JSONB ->> cast.
    const rendered = await db
      .select({
        clipIndex: sql<number>`(${assets.payload} ->> 'clip_index')::int`,
      })
      .from(assets)
      .where(
        and(
          eq(assets.packageId, plan.packageId),
          eq(assets.type, RENDERED_FOR[planType]),
          sql`(${assets.payload} ->> 'plan_asset_id') = ${plan.id}`,
        ),
      );
    const renderedIndices = new Set(rendered.map((r) => r.clipIndex));

    const targets: number[] = [];
    for (let i = 0; i < clips.length; i++) {
      if (args.force || !renderedIndices.has(i)) targets.push(i);
      else totalAlreadyRendered++;
    }
    if (targets.length === 0) {
      // Everything is already rendered. Don't even log per plan unless verbose.
      continue;
    }

    planCount++;
    console.log(
      `[render-shorts]   ${plan.id} (${planType}, pkg=${plan.packageId}): ` +
        `${targets.length}/${clips.length} clip(s) to enqueue${args.force ? ' (--force)' : ''}`,
    );

    for (const i of targets) {
      if (args.dryRun) {
        console.log(`[render-shorts]     [dry-run] would enqueue clip_render:${plan.id}:${i}`);
        totalEnqueued++;
        continue;
      }
      const r = await enqueue({
        kind: 'clip_render',
        payload: { planAssetId: plan.id, clipIndex: i },
        idempotencyKey: `clip_render:${plan.id}:${i}`,
      });
      if (r.created) totalEnqueued++;
      else totalSkipped++;
    }
  }

  const verb = args.dryRun ? '[dry-run] would enqueue' : 'enqueued';
  console.log(
    `[render-shorts] done: ${verb} ${totalEnqueued} job(s) across ${planCount} plan(s); ` +
      `${totalSkipped} already in-queue, ${totalAlreadyRendered} clip(s) already rendered.`,
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[render-shorts] fatal:', err);
    process.exit(1);
  });
