import { db } from '@/db/client';
import { assets, brands, dispatches, packages } from '@/db/schema';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { submitBrief } from '../integrations/dojoclaw';
import { createPost, networkFor } from '../integrations/zernio';
import type { JobRow } from '../queue';

const Payload = z.object({
  assetId: z.string().regex(/^ast_/),
});

/**
 * §13 step 11+12. Single dispatch worker that routes an approved asset to
 * the right downstream system. Routing per §8/§9:
 *
 *   article_brief                → DojoClaw  (local LAN HTTP)
 *   linkedin_post / x_post / x_thread / rendered_short_clip
 *                               → Zernio   (external SDK / HTTP fallback)
 *   youtube_*                    → manual   (operator pastes; we just mark
 *                                            dispatched with target='manual')
 *
 * *_plan assets are NEVER dispatchable — the worker throws on those per
 * CLAUDE.md.
 */
export async function run(job: JobRow): Promise<void> {
  const { assetId } = Payload.parse(job.payload);

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`dispatch: asset ${assetId} not found`);
  if (asset.type.endsWith('_plan')) {
    throw new Error(`dispatch: ${assetId} is a *_plan asset and is never dispatchable`);
  }
  if (asset.status !== 'approved') {
    throw new Error(`dispatch: asset ${assetId} is not approved (status=${asset.status})`);
  }

  const [pkg] = await db.select().from(packages).where(eq(packages.id, asset.packageId)).limit(1);
  if (!pkg) throw new Error(`dispatch: package ${asset.packageId} not found`);
  const [brand] = await db.select().from(brands).where(eq(brands.id, asset.brandId)).limit(1);
  if (!brand) throw new Error(`dispatch: brand ${asset.brandId} not found`);

  const target = pickTarget(asset.type);
  console.log(`[dispatch] asset=${assetId} type=${asset.type} → target=${target}`);

  let externalId: string | null = null;
  let response: Record<string, unknown> | null = null;
  let success = false;
  let errorMsg: string | null = null;

  try {
    if (target === 'dojoclaw') {
      const res = await submitBrief({
        brand_slug: brand.slug,
        package_id: pkg.id,
        asset_id: assetId,
        brief: asset.payload as Record<string, unknown>,
        callback_url: `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}/api/webhooks/dojoclaw`,
      });
      externalId = res.job_id;
      response = res as unknown as Record<string, unknown>;
      success = true;
    } else if (target === 'zernio') {
      if (!brand.zernioProfileId) {
        throw new Error(`zernio: brand ${brand.id} has no zernio_profile_id`);
      }
      const res = await createPost({
        profileId: brand.zernioProfileId,
        network: networkFor(asset.type),
        content: contentFor(asset.type, asset.payload as Record<string, unknown>),
        callbackUrl: `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}/api/webhooks/zernio`,
      });
      externalId = res._id;
      response = res as unknown as Record<string, unknown>;
      success = true;
    } else {
      // manual — record the dispatch and let the operator paste by hand.
      externalId = null;
      response = { note: 'Manual dispatch: operator copies content from asset.' };
      success = true;
    }
  } catch (err) {
    errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch] failure: ${errorMsg}`);
  }

  await db.insert(dispatches).values({
    assetId,
    target,
    requestPayload: { type: asset.type, payload: asset.payload },
    responsePayload: response ?? {},
    externalId,
    success,
    error: errorMsg,
  });

  if (!success) {
    throw new Error(errorMsg ?? 'dispatch: unknown failure');
  }

  await db
    .update(assets)
    .set({
      status: 'scheduled',
      dispatch: {
        target,
        external_id: externalId,
        dispatched_at: new Date().toISOString(),
        result: response,
      },
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, assetId));
}

function pickTarget(type: string): 'dojoclaw' | 'zernio' | 'manual' {
  if (type === 'article_brief') return 'dojoclaw';
  if (
    type === 'linkedin_post' ||
    type === 'x_post' ||
    type === 'x_thread' ||
    type === 'rendered_short_clip' ||
    type === 'rendered_long_clip'
  ) {
    return 'zernio';
  }
  return 'manual';
}

function contentFor(
  type: string,
  payload: Record<string, unknown>,
): { text?: string; mediaUrls?: string[]; threadPosts?: string[] } {
  if (type === 'x_thread' && Array.isArray(payload.posts)) {
    return { threadPosts: payload.posts as string[] };
  }
  if (type === 'rendered_short_clip' || type === 'rendered_long_clip') {
    return {
      mediaUrls: payload.public_url ? [String(payload.public_url)] : [],
      text: typeof payload.caption === 'string' ? payload.caption : undefined,
    };
  }
  return { text: typeof payload.text === 'string' ? payload.text : JSON.stringify(payload) };
}
