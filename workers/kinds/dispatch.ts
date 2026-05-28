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
import { uploadVideo as uploadYoutubeVideo } from '../integrations/youtube';
import {
  type ZernioPlatformTarget,
  createPost,
  isZernioDispatchable,
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

  const target = pickTarget(asset.type, {
    youtubeDispatchTarget: brand.youtubeDispatchTarget ?? 'manual',
    youtubeConnected: !!brand.youtubeOauth?.refresh_token,
  });
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
        // Per-article publish callback. DojoClaw signs the body with
        // `webhook_secret`; ChannelHelm's /api/webhooks/dojoclaw verifies
        // against DOJOCLAW_WEBHOOK_SECRET. Set both to the same value.
        callbackUrl: CALLBACK('/api/webhooks/dojoclaw'),
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
    } else if (target === 'youtube_direct') {
      // Bundle title + description + tags from the sibling youtube_* assets
      // on the same package. The source video is the package's original.mp4.
      const bundle = await loadYoutubeBundle(asset.packageId);
      if (!bundle.videoPath) {
        throw new Error(
          'youtube_direct: source video file path missing — cannot upload (intelligence.ingest.file_path is empty)',
        );
      }
      const origin = process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000';
      const yt = await uploadYoutubeVideo({
        brandId: brand.id,
        redirectUri: `${origin}/api/youtube/oauth/callback`,
        filePath: bundle.videoPath,
        title: bundle.title,
        description: bundle.description,
        tags: bundle.tags,
        privacyStatus: bundle.privacyStatus, // honors per-package picker (default 'private')
        ...(bundle.publishAt ? { publishAt: bundle.publishAt } : {}),
        thumbnailPath: bundle.thumbnailPath ?? undefined,
      });
      externalId = yt.videoId;
      response = yt as unknown as Record<string, unknown>;
      requestPayload = {
        type: asset.type,
        target,
        title: bundle.title,
        tags: bundle.tags,
        upload_bytes: yt.uploadBytes,
      };
      dispatchExtra.external_url = yt.url;
      dispatchExtra.video_id = yt.videoId;
      dispatchExtra.privacy = yt.privacy;
      success = true;

      // Side-effect: also mirror the YT URL onto the package so the header
      // chip lights up immediately, and flip the other youtube_* assets on
      // this package to dispatched (they're all "shipped" together).
      //
      // Read-then-write in JS (rather than jsonb_set) because PG's jsonb_set
      // doesn't auto-create intermediate object keys — a path like
      // {published,youtube} silently no-ops when `published` isn't already
      // an object on the row, which was eating the URL update on first run.
      const [latestPkg] = await db
        .select({ intelligence: packages.intelligence })
        .from(packages)
        .where(eq(packages.id, asset.packageId))
        .limit(1);
      const intel = (latestPkg?.intelligence ?? {}) as Record<string, unknown>;
      const pub = (intel.published ?? {}) as Record<string, unknown>;
      const nextIntel = {
        ...intel,
        published: {
          ...pub,
          youtube: {
            url: yt.url,
            video_id: yt.videoId,
            set_at: new Date().toISOString(),
            privacy: yt.privacy,
          },
        },
      };
      await db
        .update(packages)
        .set({ intelligence: nextIntel })
        .where(eq(packages.id, asset.packageId));
      await db
        .update(assets)
        .set({
          status: 'dispatched',
          dispatch: { target: 'youtube_direct', external_url: yt.url, video_id: yt.videoId },
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(assets.packageId, asset.packageId),
            inArray(assets.type, ['youtube_description', 'youtube_chapters', 'youtube_tags']),
          ),
        );
    } else if (target === 'zernio') {
      const accounts = (brand.zernioAccounts ?? {}) as Record<string, string>;
      let platforms = resolveZernioPlatforms(asset.type, accounts);

      // Per-clip publish_options.platforms (Shorts editor): the operator
      // may have toggled OFF some of the candidate networks for THIS
      // specific clip. Apply that filter on top of brand-configured
      // accounts. Empty selection = "all configured networks" (operator
      // didn't override).
      const clipPlatformToggles = (
        asset.payload as { publish_options?: { platforms?: Record<string, boolean> } } | undefined
      )?.publish_options?.platforms as Record<string, boolean> | undefined;
      if (clipPlatformToggles) {
        const enabled = Object.entries(clipPlatformToggles)
          .filter(([_, on]) => on)
          .map(([net]) => net);
        if (enabled.length > 0) {
          platforms = platforms.filter((p) => enabled.includes(p.platform));
        }
      }

      if (platforms.length === 0) {
        throw new Error(
          `zernio: brand ${brand.id} has no account configured for ${asset.type} (set brands.zernio_accounts)`,
        );
      }
      await enforceDailyLimit(platforms);

      const { content, threadPosts, mediaUrls } = await buildZernioContent(asset);

      // Per-clip scheduled publish (Shorts editor): privacy='schedule'
      // with a publish_at ISO timestamp → pass through to Zernio's
      // createPost.scheduledFor. Other privacy values are platform-
      // controlled (Zernio's SDK doesn't expose per-platform privacy in
      // the current surface — operator manages on the platform side).
      const publishOptions = (
        asset.payload as {
          publish_options?: { privacy?: string; publish_at?: string };
        }
      )?.publish_options;
      const scheduledFor =
        publishOptions?.privacy === 'schedule' && publishOptions.publish_at
          ? publishOptions.publish_at
          : undefined;

      const res = await createPost({
        content,
        platforms,
        mediaUrls,
        threadPosts,
        ...(scheduledFor ? { scheduledFor } : {}),
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
        ...(scheduledFor ? { scheduledFor } : {}),
      };
      if (mediaUrls?.[0]) dispatchExtra.media_url = mediaUrls[0];
      if (scheduledFor) dispatchExtra.scheduled_for = scheduledFor;
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

type DispatchTarget = 'dojoclaw' | 'zernio' | 'manual' | 'youtube_direct';

/**
 * Pull the title/description/tags from the sibling youtube_* assets and the
 * source video path from the package's intelligence.ingest. Used by the
 * youtube_direct dispatch branch.
 */
async function loadYoutubeBundle(packageId: string): Promise<{
  title: string;
  description: string;
  tags: string[];
  videoPath: string | null;
  thumbnailPath: string | null;
  privacyStatus: 'public' | 'unlisted' | 'private';
  publishAt: string | null;
}> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error(`youtube_direct: package ${packageId} not found`);
  const [src] = await db.select().from(sources).where(eq(sources.id, pkg.sourceId)).limit(1);
  const siblings = await db
    .select()
    .from(assets)
    .where(
      and(
        eq(assets.packageId, packageId),
        inArray(assets.type, [
          'youtube_title_set',
          'youtube_description',
          'youtube_tags',
          'thumbnail_concept',
        ]),
      ),
    );
  const titleAsset = siblings.find((a) => a.type === 'youtube_title_set');
  const descAsset = siblings.find((a) => a.type === 'youtube_description');
  const tagsAsset = siblings.find((a) => a.type === 'youtube_tags');
  const thumbAsset = siblings
    .filter((a) => a.type === 'thumbnail_concept')
    .sort((a, b) => {
      const ar = (a.payload as { rank?: number } | undefined)?.rank ?? 99;
      const br = (b.payload as { rank?: number } | undefined)?.rank ?? 99;
      return ar - br;
    })[0];

  // Title: respect the operator-selected index from the title_set payload.
  const titlePayload =
    (titleAsset?.payload as { titles?: { text: string }[]; selectedIndex?: number } | undefined) ??
    {};
  const titles = Array.isArray(titlePayload.titles) ? titlePayload.titles : [];
  const idx = Math.min(
    Math.max(titlePayload.selectedIndex ?? 0, 0),
    Math.max(titles.length - 1, 0),
  );
  const title = titles[idx]?.text?.trim() || 'Untitled video';

  const description =
    ((descAsset?.payload as { text?: string } | undefined)?.text ?? '').trim() || '';
  const tagsPayload =
    (tagsAsset?.payload as { tags?: ({ text: string } | string)[] } | undefined) ?? {};
  const tags = (tagsPayload.tags ?? [])
    .map((t) => (typeof t === 'string' ? t : t?.text))
    .filter((t): t is string => !!t && t.length > 0)
    .slice(0, 30);

  // Source video. Two paths to try, in order — the first that exists on disk
  // wins. This guards against the well-known gotcha where a brand slug
  // renormalize moves the media folder but doesn't rewrite the stored
  // `intelligence.ingest.file_path` snapshot.
  //
  //   1. sources.local_media_path + 'original.<ext>'  (renorm updates this)
  //   2. packages.intelligence.ingest.file_path        (captured at ingest)
  const intel = (pkg.intelligence ?? {}) as { ingest?: { file_path?: string } };
  const candidates: string[] = [];
  if (src?.localMediaPath) {
    // The upload route stores files as original.<ext>. Probe a few common ones.
    for (const ext of ['mp4', 'mov', 'webm', 'm4v', 'mkv']) {
      candidates.push(`${src.localMediaPath}/original.${ext}`);
    }
  }
  if (intel.ingest?.file_path) candidates.push(intel.ingest.file_path);

  let videoPath: string | null = null;
  for (const p of candidates) {
    try {
      const { statSync } = await import('node:fs');
      statSync(p);
      videoPath = p;
      break;
    } catch {
      // file doesn't exist here — try the next candidate
    }
  }

  const thumbnailPath =
    (thumbAsset?.payload as { local_path?: string } | undefined)?.local_path ?? null;

  // Per-package YouTube publish options. YouTube's API requires
  // privacyStatus='private' when publishAt is set — it auto-flips public at
  // the scheduled time. Normalize 'schedule' → ('private', publishAt) here
  // so the worker doesn't have to think about it.
  const publishOpts = ((pkg.intelligence ?? {}) as Record<string, unknown>).publish_options ?? {};
  const ytOpts = ((publishOpts as Record<string, unknown>).youtube ?? {}) as {
    privacy?: string;
    publish_at?: string;
  };
  let privacyStatus: 'public' | 'unlisted' | 'private' = 'private';
  let publishAt: string | null = null;
  if (ytOpts.privacy === 'public' || ytOpts.privacy === 'unlisted') {
    privacyStatus = ytOpts.privacy;
  } else if (ytOpts.privacy === 'schedule' && ytOpts.publish_at) {
    privacyStatus = 'private';
    publishAt = ytOpts.publish_at;
  }

  return { title, description, tags, videoPath, thumbnailPath, privacyStatus, publishAt };
}

function pickTarget(
  type: string,
  ctx: { youtubeDispatchTarget: string; youtubeConnected: boolean },
): DispatchTarget {
  if (type === 'article_brief') return 'dojoclaw';
  // Any asset type with a Zernio network mapping routes to Zernio — covers the
  // core social posts, rendered clips, and the extended networks (facebook_post,
  // threads_post, pinterest_pin, reddit_post, bluesky_post, telegram_post,
  // discord_message, google_business_post). New networks auto-route.
  if (isZernioDispatchable(type)) {
    return 'zernio';
  }
  // YouTube long-form: only the title_set asset triggers the upload — it's
  // the "publish package's video to YouTube" representative. The other
  // youtube_* assets stay manual (they're already embedded in the upload via
  // the description / tags). Only flip to youtube_direct if both the brand
  // opted in AND the OAuth tokens are present (otherwise we fall back to
  // manual rather than failing the dispatch silently).
  if (
    type === 'youtube_title_set' &&
    ctx.youtubeDispatchTarget === 'youtube_direct' &&
    ctx.youtubeConnected
  ) {
    return 'youtube_direct';
  }
  return 'manual';
}
