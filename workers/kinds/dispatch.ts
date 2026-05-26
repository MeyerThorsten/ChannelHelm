import { db } from '@/db/client';
import { assets, brands, dispatches, packages, sources } from '@/db/schema';
import { signedMediaUrl } from '@/lib/media-sign';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  type ArticleBrief,
  formatBriefAsSourceText,
  syndicateStory,
} from '../integrations/dojoclaw';
import {
  type ZernioPlatformTarget,
  createPost,
  resolveZernioPlatforms,
} from '../integrations/zernio';
import { recomputePackageDispatchState } from '../lib/lifecycle';
import { type JobRow, RequeueLater } from '../queue';

const Payload = z.object({ assetId: z.string().regex(/^ast_/) });

const ZERNIO_DAILY_LIMIT = 20; // §9.6 per-account/day
const CALLBACK = (path: string) =>
  `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}${path}`;

/**
 * §13 step 11+12. Routes an approved asset to the right downstream system:
 *   article_brief → DojoClaw (§8.2)   ·  linkedin/x/clips → Zernio (§9.3)
 *   youtube_*     → manual (operator pastes; recorded as dispatched)
 *
 * Enforces: *_plan never dispatched (CLAUDE.md); §9.6 per-account daily limit
 * (requeue, don't fail); §9.4 signed media URL required for rendered clips;
 * §10 package dispatch state recomputed after each outcome. Idempotent on
 * recovery — a re-run after a crash skips an already-dispatched asset.
 */
export async function run(job: JobRow): Promise<void> {
  const { assetId } = Payload.parse(job.payload);

  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`dispatch: asset ${assetId} not found`);
  if (asset.type.endsWith('_plan')) {
    throw new Error(`dispatch: ${assetId} is a *_plan asset and is never dispatchable`);
  }

  const existingDispatch = (asset.dispatch ?? {}) as { external_id?: string };
  if (
    (asset.status === 'dispatched' || asset.status === 'published') &&
    existingDispatch.external_id
  ) {
    console.log(
      `[dispatch] ${assetId} already dispatched (${existingDispatch.external_id}) — skip`,
    );
    return;
  }
  if (asset.status !== 'approved') {
    throw new Error(`dispatch: asset ${assetId} is not approved (status=${asset.status})`);
  }

  const [pkg] = await db.select().from(packages).where(eq(packages.id, asset.packageId)).limit(1);
  if (!pkg) throw new Error(`dispatch: package ${asset.packageId} not found`);
  const [brand] = await db.select().from(brands).where(eq(brands.id, asset.brandId)).limit(1);
  if (!brand) throw new Error(`dispatch: brand ${asset.brandId} not found`);

  const target = pickTarget(asset.type);
  console.log(`[dispatch] asset=${assetId} type=${asset.type} → ${target}`);

  let externalId: string | null = null;
  let response: Record<string, unknown> | null = null;
  let requestPayload: Record<string, unknown> = { type: asset.type, target };
  let success = false;
  let errorMsg: string | null = null;
  const dispatchExtra: Record<string, unknown> = {};

  try {
    if (target === 'dojoclaw') {
      // Pull the originating source (YouTube/podcast URL) so we can pass it as
      // the article permalink / footer attribution — DojoClaw uses it verbatim.
      const [source] = pkg.sourceId
        ? await db.select().from(sources).where(eq(sources.id, pkg.sourceId)).limit(1)
        : [undefined];
      const brief = asset.payload as ArticleBrief;
      // dojoclaw_sites is jsonb (array of {site, topic, ...} per the brand schema);
      // pick the first entry's topic when set, else fall back. Keep this defensive
      // because the array shape is brand-defined and may evolve.
      const sites = Array.isArray(brand.dojoclawSites) ? brand.dojoclawSites : [];
      const firstSite = sites[0] as { topic?: string } | undefined;
      const topic = (firstSite?.topic as string | undefined) ?? 'tech';
      const headline = (brief.working_title as string | undefined) ?? `Brief ${assetId}`;
      const sourceText = formatBriefAsSourceText(brief, {
        brandName: brand.name,
        voiceProfile: brand.voiceProfile,
      });
      const res = await syndicateStory({
        storyId: `channelhelm:${assetId}`,
        headline,
        url: source?.originUrl ?? `https://channelhelm.local/briefs/${assetId}`,
        source: brand.slug,
        sourceName: brand.name,
        topic,
        maxSites: Math.max(1, Math.min(15, sites.length || 5)),
        sourceText,
      });
      externalId = res.storyId;
      response = res as unknown as Record<string, unknown>;
      requestPayload = {
        type: asset.type,
        target,
        brief_id: assetId,
        endpoint: 'syndicate',
        site_count: res.count,
      };
      success = true;
    } else if (target === 'zernio') {
      const accounts = (brand.zernioAccounts ?? {}) as Record<string, string>;
      const platforms = resolveZernioPlatforms(asset.type, accounts);
      if (platforms.length === 0) {
        throw new Error(
          `zernio: brand ${brand.id} has no account configured for ${asset.type} (set brands.zernio_accounts)`,
        );
      }
      await enforceDailyLimit(platforms);

      const { content, threadPosts, mediaUrls } = await buildZernioContent(asset);
      const res = await createPost({
        content,
        platforms,
        mediaUrls,
        threadPosts,
        metadata: {
          channelhelmAssetId: assetId,
          channelhelmPackageId: pkg.id,
          channelhelmBrandId: brand.id,
        },
        callbackUrl: CALLBACK('/api/webhooks/zernio'),
      });
      externalId = res._id;
      response = res as unknown as Record<string, unknown>;
      requestPayload = {
        type: asset.type,
        target,
        accounts: platforms.map((p) => p.accountId),
        platforms,
        mediaUrls,
      };
      if (mediaUrls?.[0]) dispatchExtra.media_url = mediaUrls[0];
      success = true;
    } else {
      response = { note: 'Manual dispatch: operator copies content from asset.' };
      requestPayload = { type: asset.type, target };
      success = true;
    }
  } catch (err) {
    if (err instanceof RequeueLater) throw err; // deferred, not a failure
    errorMsg = err instanceof Error ? err.message : String(err);
    console.error(`[dispatch] failure: ${errorMsg}`);
  }

  await db.insert(dispatches).values({
    assetId,
    target,
    requestPayload,
    responsePayload: response ?? {},
    externalId,
    success,
    error: errorMsg,
  });

  if (!success) {
    await db
      .update(assets)
      .set({
        status: 'failed',
        dispatch: {
          ...existingDispatch,
          target,
          error: errorMsg,
          failed_at: new Date().toISOString(),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(assets.id, assetId));
    await recomputePackageDispatchState(asset.packageId);
    throw new Error(errorMsg ?? 'dispatch: unknown failure');
  }

  await db
    .update(assets)
    .set({
      status: 'dispatched',
      dispatch: {
        ...dispatchExtra,
        target,
        external_id: externalId,
        dispatched_at: new Date().toISOString(),
        result: response,
      },
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, assetId));

  await recomputePackageDispatchState(asset.packageId);
}

/** §9.6: refuse to exceed 20 successful Zernio posts per account per 24h; requeue to next UTC day. */
async function enforceDailyLimit(platforms: ZernioPlatformTarget[]): Promise<void> {
  const since = new Date(Date.now() - 24 * 3600 * 1000);
  for (const p of platforms) {
    const [row] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(dispatches)
      .where(
        and(
          eq(dispatches.target, 'zernio'),
          eq(dispatches.success, true),
          sql`${dispatches.dispatchedAt} > ${since}`,
          sql`(${dispatches.requestPayload} -> 'accounts') @> ${JSON.stringify([p.accountId])}::jsonb`,
        ),
      );
    if ((row?.n ?? 0) >= ZERNIO_DAILY_LIMIT) {
      throw new RequeueLater(
        nextUtcDayBoundary(),
        `zernio daily limit (${ZERNIO_DAILY_LIMIT}) reached for account ${p.accountId}`,
      );
    }
  }
}

function nextUtcDayBoundary(): Date {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d;
}

async function buildZernioContent(asset: {
  type: string;
  payload: unknown;
}): Promise<{ content: string; threadPosts?: string[]; mediaUrls?: string[] }> {
  const payload = (asset.payload ?? {}) as {
    text?: string;
    posts?: string[];
    caption?: string;
    media_refs?: string[];
    local_path?: string;
  };

  if (asset.type === 'x_thread' && Array.isArray(payload.posts) && payload.posts.length > 0) {
    return { content: payload.posts[0] ?? '', threadPosts: payload.posts.slice(1) };
  }

  if (asset.type === 'rendered_short_clip' || asset.type === 'rendered_long_clip') {
    if (!payload.local_path) {
      throw new Error('zernio: rendered clip has no local_path to publish');
    }
    const signed = signedMediaUrl(payload.local_path);
    if (!signed) {
      throw new Error(
        'zernio: cannot mint a signed media URL for the rendered clip (set CLOUDFLARE_TUNNEL_HOSTNAME + MEDIA_URL_SECRET) — refusing to dispatch without media',
      );
    }
    const caption = await resolveClipCaption(payload);
    return { content: caption, mediaUrls: [signed] };
  }

  return { content: payload.text ?? '' };
}

/** §9.3: a rendered clip pulls its platform caption asset via `media_refs`, falling back to inline. */
async function resolveClipCaption(payload: {
  caption?: string;
  media_refs?: string[];
}): Promise<string> {
  const refs = Array.isArray(payload.media_refs) ? payload.media_refs : [];
  if (refs.length > 0) {
    const rows = await db.select().from(assets).where(inArray(assets.id, refs));
    const cap = rows.find((r) => r.type.endsWith('_caption'));
    const text = (cap?.payload as { text?: string } | undefined)?.text;
    if (text) return text;
  }
  return payload.caption ?? '';
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
