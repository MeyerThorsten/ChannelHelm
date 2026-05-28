'use server';

import { db } from '@/db/client';
import { assets, brands, packages } from '@/db/schema';
import { complete } from '@workers/integrations/lm_studio';
import { loadPrompt, render } from '@workers/integrations/prompts';
import { fetchTopComments } from '@workers/integrations/youtube';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

/**
 * Post-publish "comment mining → content loop". On demand (comments only exist
 * after a video is live), pull the top YouTube comments for a package's
 * published video and turn them into two reference assets:
 *   - content_ideas: 5-8 next-video ideas
 *   - faq:           a clustered viewer FAQ
 *
 * NOT part of the pre-publish generate fan-out — these types are deliberately
 * absent from ASSET_TYPES in analyze_intelligence.ts. They're internal/
 * reference (approvalRequired: false), never dispatched.
 *
 * Runs the LLM SYNCHRONOUSLY in the Server Action — the same documented
 * Content-Studio carve-out used by regenerate.ts (bounded, text-only call).
 */
export async function mineComments(
  packageId: string,
): Promise<{ comments: number; ideas: number; faq: number }> {
  const [pkg] = await db.select().from(packages).where(eq(packages.id, packageId)).limit(1);
  if (!pkg) throw new Error('mineComments: package not found');

  const videoId = await findPublishedVideoId(packageId);
  if (!videoId) {
    throw new Error(
      'No published YouTube video for this package yet — publish it via YouTube Direct before mining comments.',
    );
  }

  const [brand] = await db.select().from(brands).where(eq(brands.id, pkg.brandId)).limit(1);
  if (!brand) throw new Error(`mineComments: brand ${pkg.brandId} not found`);

  const intelligence = pkg.intelligence as Record<string, unknown>;
  if (!intelligence.analysis) {
    throw new Error(
      'mineComments: package.intelligence.analysis missing — the analysis pipeline must run first.',
    );
  }

  const redirectUri = `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}/api/youtube/oauth/callback`;

  // Scope: top-level comments only (replies are excluded), ordered by
  // relevance, single page of up to 50.
  const comments = await fetchTopComments({
    brandId: brand.id,
    redirectUri,
    videoId,
    max: 50,
  });
  if (comments.length === 0) {
    throw new Error(
      'No comments yet (or comments are disabled) — nothing to mine. Try again once viewers have commented.',
    );
  }

  // Feed the LLM a compact, de-noised view of each comment.
  const commentsBlock = comments
    .map((c, i) => `${i + 1}. [${c.likeCount} likes] ${c.text.replace(/\s+/g, ' ').trim()}`)
    .join('\n');

  const ideas = await generateMined('content_ideas', {
    brand,
    intelligence,
    commentsBlock,
    videoId,
  });
  const faq = await generateMined('faq', { brand, intelligence, commentsBlock, videoId });

  const ideasCount = Array.isArray((ideas.payload as { ideas?: unknown[] }).ideas)
    ? (ideas.payload as { ideas: unknown[] }).ideas.length
    : 0;
  const faqCount = Array.isArray((faq.payload as { items?: unknown[] }).items)
    ? (faq.payload as { items: unknown[] }).items.length
    : 0;

  await upsertReferenceAsset(packageId, brand.id, 'content_ideas', ideas.payload, ideas.provenance);
  await upsertReferenceAsset(packageId, brand.id, 'faq', faq.payload, faq.provenance);

  revalidatePath(`/packages/${packageId}`);
  return { comments: comments.length, ideas: ideasCount, faq: faqCount };
}

/** Load + render a mining prompt, call the LLM, parse the JSON payload. */
async function generateMined(
  assetType: 'content_ideas' | 'faq',
  ctx: {
    brand: typeof brands.$inferSelect;
    intelligence: Record<string, unknown>;
    commentsBlock: string;
    videoId: string;
  },
): Promise<{ payload: Record<string, unknown>; provenance: Record<string, unknown> }> {
  const prompt = await loadPrompt(assetType); // latest version
  const user = render(prompt, {
    brand: ctx.brand,
    intelligence: ctx.intelligence,
    comments: ctx.commentsBlock,
  });
  const result = await complete({
    profile: 'fast_audio_only', // text-only; profile only steers provider routing
    system: prompt.system ?? undefined,
    user,
    promptVersion: `${prompt.name}.v${prompt.version}`,
    inputRefs: [`comments:youtube:${ctx.videoId}`],
    maxTokens: 2048,
    temperature: 0.7,
  });
  return {
    payload: parseJson(result.text, `mineComments:${assetType}`),
    provenance: result.provenance as unknown as Record<string, unknown>,
  };
}

/**
 * UPSERT one reference asset per (package, type). Dedupe/replace any existing
 * same-type row so re-mining overwrites rather than piling up. Status
 * ready_for_review, approvalRequired false (internal — never dispatched).
 */
async function upsertReferenceAsset(
  packageId: string,
  brandId: string,
  type: 'content_ideas' | 'faq',
  payload: Record<string, unknown>,
  provenance: Record<string, unknown>,
): Promise<void> {
  const [existing] = await db
    .select({ id: assets.id })
    .from(assets)
    .where(and(eq(assets.packageId, packageId), eq(assets.type, type)))
    .limit(1);

  if (existing) {
    await db
      .update(assets)
      .set({
        payload,
        provenance,
        status: 'ready_for_review',
        approvalRequired: false,
        updatedAt: sql`now()`,
      })
      .where(eq(assets.id, existing.id));
    return;
  }
  await db.insert(assets).values({
    packageId,
    brandId,
    type,
    status: 'ready_for_review',
    approvalRequired: false,
    payload,
    provenance,
  });
}

/** Find the published YouTube video id for a package (mirrors experiments.ts). */
async function findPublishedVideoId(packageId: string): Promise<string | null> {
  const rows = await db
    .select({ dispatch: assets.dispatch })
    .from(assets)
    .where(eq(assets.packageId, packageId));
  for (const r of rows) {
    const d = (r.dispatch ?? {}) as { video_id?: string; external_id?: string; target?: string };
    if (d.target === 'youtube_direct' && (d.video_id || d.external_id)) {
      return d.video_id ?? d.external_id ?? null;
    }
  }
  const [pkg] = await db
    .select({ intel: packages.intelligence })
    .from(packages)
    .where(eq(packages.id, packageId))
    .limit(1);
  const vid = (pkg?.intel as { youtube?: { video_id?: string } } | null)?.youtube?.video_id;
  return vid ?? null;
}

/** Strip code fences and parse strict JSON; throw a useful error otherwise. */
function parseJson(text: string, label: string): Record<string, unknown> {
  const stripped = text
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  try {
    return JSON.parse(stripped) as Record<string, unknown>;
  } catch {
    throw new Error(
      `${label}: model did not return valid JSON. First 200 chars: ${stripped.slice(0, 200)}`,
    );
  }
}
