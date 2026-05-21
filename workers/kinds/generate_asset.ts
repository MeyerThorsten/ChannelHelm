import { db } from '@/db/client';
import { assets, brands, packages } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { generateAssetContent } from '../lib/generate';
import type { JobRow } from '../queue';

const Payload = z.object({
  sourceId: z.string().regex(/^src_/),
  packageId: z.string().regex(/^pkg_/),
  assetType: z.string().min(1),
  processingProfile: z.string().optional(),
});

/**
 * §13 step 9. Generates one asset type via the shared
 * `generateAssetContent()` (also used by the interactive regenerate Server
 * Action) and INSERTs a row into `assets` with §2.2 provenance.
 *
 * Idempotency key (set by the enqueuer) is `generate_asset:{package_id}:{type}`,
 * so re-running analyze_intelligence won't duplicate assets unless the prior
 * job row is deleted first.
 */
export async function run(job: JobRow): Promise<void> {
  const { packageId, assetType, processingProfile } = Payload.parse(job.payload);

  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`generate_asset: package ${packageId} not found`);
  const [brand] = await db.select().from(brands).where(eq(brands.id, pkg.brandId)).limit(1);
  if (!brand) throw new Error(`generate_asset: brand ${pkg.brandId} not found`);

  console.log(`[generate_asset] type=${assetType} package=${packageId}`);
  const { payload, provenance } = await generateAssetContent({
    packageId,
    assetType,
    processingProfile,
  });

  // Respect the brand's auto_dispatch_for list. Default is "approval required";
  // brands can opt specific asset types into auto-dispatch via that JSONB array.
  const autoDispatch =
    Array.isArray(brand.autoDispatchFor) && brand.autoDispatchFor.includes(assetType);
  const approvalRequired = !autoDispatch;
  const status = approvalRequired ? 'ready_for_review' : 'approved';

  // Upsert by (package, type): if the operator already generated this section
  // on demand from the studio, update that row instead of inserting a
  // duplicate. (The §4 idempotency key stops duplicate JOBS; this stops
  // duplicate ASSET rows when the manual + automatic paths overlap.)
  const [existing] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.packageId, packageId), eq(assets.type, assetType)))
    .limit(1);
  if (existing) {
    await db
      .update(assets)
      .set({ payload, provenance, status, approvalRequired, updatedAt: sql`now()` })
      .where(eq(assets.id, existing.id));
    console.log(`[generate_asset] updated ${existing.id} type=${assetType}`);
    return;
  }
  const [row] = await db
    .insert(assets)
    .values({
      packageId,
      brandId: brand.id,
      type: assetType,
      status,
      approvalRequired,
      payload,
      provenance,
    })
    .returning();
  if (!row) throw new Error('generate_asset: insert returned no row');
  console.log(`[generate_asset] inserted ${row.id} type=${assetType}`);
}
