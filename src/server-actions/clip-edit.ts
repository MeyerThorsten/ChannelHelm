'use server';

/**
 * Server actions for the per-Short editor. All three operate on a single
 * clip entry inside a `short_clip_plan` (or `long_clip_plan`) asset's
 * `payload.clips[clipIndex]`. The plan is the editable source of truth;
 * the rendered asset is a build output that gets refreshed by
 * `clip_render` via UPSERT.
 *
 *   saveClipEdits         — persist partial edits (title / description /
 *                           tags / trim / styling / description_links /
 *                           b_roll_enabled). Auto-saved from the editor.
 *   renderClip            — bump render_rev, set pending_render, enqueue
 *                           clip_render. Called by the explicit "Render"
 *                           button after edits.
 *   setClipPublishOptions — persist platforms + privacy + publish_at for
 *                           the per-clip publish modal.
 *
 * Logging: every save appends to `payload.edits_log[]` so we can
 * reconstruct who-changed-what later if needed. All three revalidate
 * the package page so the Studio re-fetches.
 */

import { db } from '@/db/client';
import { assets, brands, packages } from '@/db/schema';
import { complete } from '@workers/integrations/lm_studio';
import { loadPrompt, render } from '@workers/integrations/prompts';
import { enqueue } from '@workers/queue';
import { and, eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

// ─── shared types ──────────────────────────────────────────────────────────

type StylingInput = {
  font?: string;
  font_size?: number;
  font_color?: string;
  highlight_color?: string;
  animation?: string;
  x_pos?: number;
  y_pos?: number;
};

type PublishOptionsInput = {
  platforms?: { youtube?: boolean; tiktok?: boolean; instagram?: boolean };
  privacy?: 'public' | 'unlisted' | 'private' | 'schedule';
  publish_at?: string;
};

export type ClipEdits = {
  title?: string;
  caption?: string;
  description?: string;
  tags?: string[];
  trim?: { start: number; end: number };
  styling?: StylingInput;
  description_links?: { label: string; url: string }[];
  b_roll_enabled?: boolean;
};

// ─── helpers ──────────────────────────────────────────────────────────────

/**
 * Load a plan asset by id, validate it's a *_plan, and return its payload
 * with the operator's target clip located. Throws clean error messages
 * the editor surfaces inline.
 */
async function loadPlanAndClip(planAssetId: string, clipIndex: number) {
  if (!planAssetId.startsWith('ast_')) throw new Error('invalid planAssetId');
  const [plan] = await db.select().from(assets).where(eq(assets.id, planAssetId)).limit(1);
  if (!plan) throw new Error(`plan asset ${planAssetId} not found`);
  if (plan.type !== 'short_clip_plan' && plan.type !== 'long_clip_plan') {
    throw new Error(`asset ${planAssetId} is not a *_plan asset (type=${plan.type})`);
  }
  const payload = (plan.payload ?? {}) as { clips?: Record<string, unknown>[] };
  const clips = Array.isArray(payload.clips) ? payload.clips : [];
  if (clipIndex < 0 || clipIndex >= clips.length) {
    throw new Error(`plan ${planAssetId} has no clip at index ${clipIndex} (len=${clips.length})`);
  }
  return { plan, payload, clips };
}

/** Append an entry to plan.payload.edits_log for audit. */
function appendEditsLog(
  payload: Record<string, unknown>,
  clipIndex: number,
  fields: string[],
): Record<string, unknown> {
  const log = Array.isArray(payload.edits_log)
    ? (payload.edits_log as { at: string; by: string; fields: string[] }[])
    : [];
  log.push({
    at: new Date().toISOString(),
    by: 'operator',
    fields: fields.map((f) => `clips.${clipIndex}.${f}`),
  });
  return { ...payload, edits_log: log };
}

function renderedTypeForPlan(planType: string): 'rendered_short_clip' | 'rendered_long_clip' {
  return planType === 'long_clip_plan' ? 'rendered_long_clip' : 'rendered_short_clip';
}

function isTerminalRenderedStatus(status: string): boolean {
  return status === 'dispatched' || status === 'published';
}

// ─── saveClipEdits ────────────────────────────────────────────────────────

/**
 * Persist a partial edit set to one clip entry. Called from the editor
 * on debounced save. Unknown / undefined edit fields are ignored; only
 * provided fields are written.
 *
 * Validates:
 *   - title ≤ 100 chars
 *   - trim.start < trim.end, both ≥ 0
 *   - styling.x_pos / y_pos in [0, 1]
 *   - tags: up to 30 strings
 *   - description_links: up to 8 entries with url that parses
 */
export async function saveClipEdits(
  planAssetId: string,
  clipIndex: number,
  edits: ClipEdits,
): Promise<void> {
  const { plan, payload, clips } = await loadPlanAndClip(planAssetId, clipIndex);

  const fieldsTouched: string[] = [];
  const cur = (clips[clipIndex] ?? {}) as Record<string, unknown>;
  const next: Record<string, unknown> = { ...cur };

  if (edits.title !== undefined) {
    if (edits.title.length > 100) throw new Error('title must be ≤ 100 chars');
    next.title = edits.title;
    fieldsTouched.push('title');
  }
  if (edits.caption !== undefined) {
    if (edits.caption.length > 200) throw new Error('caption must be ≤ 200 chars');
    next.caption = edits.caption;
    fieldsTouched.push('caption');
  }
  if (edits.description !== undefined) {
    next.description = edits.description;
    fieldsTouched.push('description');
  }
  if (edits.tags !== undefined) {
    if (!Array.isArray(edits.tags)) throw new Error('tags must be an array');
    if (edits.tags.length > 30) throw new Error('tags: max 30');
    next.tags = edits.tags.map((t) => String(t).trim()).filter(Boolean);
    fieldsTouched.push('tags');
  }
  if (edits.trim !== undefined) {
    const { start, end } = edits.trim;
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error('trim must be numbers');
    if (start < 0 || end <= start) throw new Error('trim.end must be > trim.start ≥ 0');
    next.trim = { start, end };
    fieldsTouched.push('trim');
  }
  if (edits.styling !== undefined) {
    const s = edits.styling;
    if (s.x_pos != null && (s.x_pos < 0 || s.x_pos > 1)) {
      throw new Error('styling.x_pos must be in [0, 1]');
    }
    if (s.y_pos != null && (s.y_pos < 0 || s.y_pos > 1)) {
      throw new Error('styling.y_pos must be in [0, 1]');
    }
    next.styling = { ...((cur.styling as object | undefined) ?? {}), ...s };
    fieldsTouched.push('styling');
  }
  if (edits.description_links !== undefined) {
    if (!Array.isArray(edits.description_links)) throw new Error('description_links must be array');
    if (edits.description_links.length > 8) throw new Error('description_links: max 8');
    const cleaned = [];
    for (const link of edits.description_links) {
      if (!link?.url) continue;
      try {
        new URL(link.url);
      } catch {
        throw new Error(`invalid url in description_links: ${link.url}`);
      }
      cleaned.push({ label: String(link.label ?? '').slice(0, 60), url: link.url });
    }
    next.description_links = cleaned;
    fieldsTouched.push('description_links');
  }
  if (edits.b_roll_enabled !== undefined) {
    next.b_roll_enabled = !!edits.b_roll_enabled;
    fieldsTouched.push('b_roll_enabled');
  }

  if (fieldsTouched.length === 0) return; // nothing to do

  const newClips = clips.slice();
  newClips[clipIndex] = next;
  const newPayload = appendEditsLog({ ...payload, clips: newClips }, clipIndex, fieldsTouched);

  await db
    .update(assets)
    .set({ payload: newPayload, updatedAt: sql`now()` })
    .where(eq(assets.id, planAssetId));
  revalidatePath(`/packages/${plan.packageId}`);
  revalidatePath(`/packages/${plan.packageId}/shorts/${clipIndex}`);
}

// ─── setClipPublishOptions ─────────────────────────────────────────────────

/**
 * Persist per-clip publish_options (platforms + privacy + schedule).
 * Mirrors the YoutubePublishOptions server action's validation rules.
 */
export async function setClipPublishOptions(
  planAssetId: string,
  clipIndex: number,
  options: PublishOptionsInput,
): Promise<void> {
  const { plan, payload, clips } = await loadPlanAndClip(planAssetId, clipIndex);

  if (options.privacy && !['public', 'unlisted', 'private', 'schedule'].includes(options.privacy)) {
    throw new Error(`unknown privacy '${options.privacy}'`);
  }
  let publishAt: string | undefined;
  if (options.privacy === 'schedule') {
    if (!options.publish_at) throw new Error('publish_at required when privacy=schedule');
    const ms = Date.parse(options.publish_at);
    if (!Number.isFinite(ms)) throw new Error('publish_at is not a valid ISO timestamp');
    if (ms - Date.now() < 60_000) {
      throw new Error('publish_at must be at least 1 minute in the future');
    }
    publishAt = new Date(ms).toISOString();
  }

  const cur = (clips[clipIndex] ?? {}) as Record<string, unknown>;
  const newOptions = {
    ...((cur.publish_options as object | undefined) ?? {}),
    ...(options.platforms ? { platforms: options.platforms } : {}),
    ...(options.privacy ? { privacy: options.privacy } : {}),
    ...(publishAt ? { publish_at: publishAt } : {}),
  };
  const newClips = clips.slice();
  newClips[clipIndex] = { ...cur, publish_options: newOptions };
  const newPayload = appendEditsLog({ ...payload, clips: newClips }, clipIndex, [
    'publish_options',
  ]);

  await db
    .update(assets)
    .set({ payload: newPayload, updatedAt: sql`now()` })
    .where(eq(assets.id, planAssetId));
  revalidatePath(`/packages/${plan.packageId}`);
  revalidatePath(`/packages/${plan.packageId}/shorts/${clipIndex}`);
}

// ─── renderClip ───────────────────────────────────────────────────────────

/**
 * Bump the clip's render_rev + set pending_render, then enqueue a
 * clip_render job with an idempotency key that includes the new rev.
 * The worker UPSERTs the rendered asset and clears pending_render on
 * success.
 *
 * Returns the new render_rev so the editor can show a live indicator.
 */
export async function renderClip(planAssetId: string, clipIndex: number): Promise<number> {
  const { plan, payload, clips } = await loadPlanAndClip(planAssetId, clipIndex);

  const cur = (clips[clipIndex] ?? {}) as Record<string, unknown>;
  if (cur.deleted === true) {
    throw new Error('clip has been deleted from the plan');
  }

  const [existingRendered] = await db
    .select({ id: assets.id, status: assets.status })
    .from(assets)
    .where(
      and(
        eq(assets.packageId, plan.packageId),
        eq(assets.type, renderedTypeForPlan(plan.type)),
        sql`(${assets.payload} ->> 'plan_asset_id') = ${planAssetId}`,
        sql`(${assets.payload} ->> 'clip_index')::int = ${clipIndex}`,
      ),
    )
    .limit(1);
  if (existingRendered && isTerminalRenderedStatus(existingRendered.status)) {
    throw new Error(
      `clip already ${existingRendered.status}; create a new plan clip instead of re-rendering ${existingRendered.id}`,
    );
  }

  const newRev = (Number(cur.render_rev) || 0) + 1;
  const newClips = clips.slice();
  newClips[clipIndex] = { ...cur, render_rev: newRev, pending_render: true };
  await db
    .update(assets)
    .set({
      payload: appendEditsLog({ ...payload, clips: newClips }, clipIndex, ['render_rev']),
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, planAssetId));

  await enqueue({
    kind: 'clip_render',
    payload: { planAssetId, clipIndex },
    // Including the rev in the idempotency key lets each operator-
    // triggered render get its own job row while still de-duping a
    // double-click that fires twice with the same rev.
    idempotencyKey: `clip_render:${planAssetId}:${clipIndex}:rev${newRev}`,
  });

  revalidatePath(`/packages/${plan.packageId}`);
  revalidatePath(`/packages/${plan.packageId}/shorts/${clipIndex}`);
  return newRev;
}

// ─── generateClipDescription ───────────────────────────────────────────────

/**
 * Generate a post-body description for one clip via the LLM and persist
 * it onto plan.clips[i].description. Auto-fired from the editor when a
 * clip's description is empty AND has never been generated before.
 *
 * Documented Server-Action carve-out (CLAUDE.md): synchronous LLM call
 * is allowed for interactive single-asset regeneration. This is a
 * bounded text-only call (≤ 280 chars of output, ~5-10 s of model time).
 *
 * Sets `description_generated_at` regardless of LLM outcome so we never
 * retry on subsequent editor opens — operators can still edit by hand.
 *
 * Returns the generated text (or empty string if the LLM produced
 * nothing useful), so the caller can update its local state immediately.
 */
export async function generateClipDescription(
  planAssetId: string,
  clipIndex: number,
): Promise<string> {
  const { plan, payload, clips } = await loadPlanAndClip(planAssetId, clipIndex);
  const cur = (clips[clipIndex] ?? {}) as Record<string, unknown>;

  // Load brand for voice profile.
  const [brand] = await db.select().from(brands).where(eq(brands.id, plan.brandId)).limit(1);
  if (!brand) throw new Error(`generateClipDescription: brand ${plan.brandId} not found`);

  // Load package intelligence to extract the transcript slice in the
  // clip's trim window. Without word-level segments we degrade to whatever
  // overlap with the segment-level text we can find.
  const [pkg] = await db
    .select({
      intelligence: packages.intelligence,
      processingProfile: packages.processingProfile,
    })
    .from(packages)
    .where(eq(packages.id, plan.packageId))
    .limit(1);
  if (!pkg) throw new Error(`generateClipDescription: package ${plan.packageId} not found`);

  const start = numOr(cur.trim, 'start', numOr(cur, 'start', 0));
  const end = numOr(cur.trim, 'end', numOr(cur, 'end', 0));
  const transcriptInTrim = extractTranscriptInRange(pkg.intelligence, start, end);

  const prompt = await loadPrompt('short_clip_description', 1);
  const user = render(prompt, {
    brand,
    clip: {
      title: String(cur.title ?? ''),
      caption: String(cur.caption ?? ''),
      hook_score: typeof cur.hook_score === 'number' ? cur.hook_score : null,
      tags: Array.isArray(cur.tags) ? cur.tags : [],
      transcript: transcriptInTrim,
    },
  });

  let generated = '';
  let succeeded = false;
  try {
    const result = await complete({
      profile: pkg.processingProfile,
      system: prompt.system ?? undefined,
      user,
      promptVersion: `${prompt.name}.v${prompt.version}`,
      inputRefs: [`plan:${planAssetId}`, `clip:${clipIndex}`],
      maxTokens: 320,
      temperature: 0.7,
    });
    generated = cleanDescription(result.text);
    succeeded = generated.length > 0;
  } catch (err) {
    // Don't crash the editor — log and stamp the timestamp anyway so
    // we don't retry forever. Operator can still type a description by hand.
    console.warn(`[generateClipDescription] LLM failed for ${planAssetId}:${clipIndex}:`, err);
  }

  // Persist: description + description_generated_at. We update even on
  // failure so empty-on-retry loops are impossible.
  const newClips = clips.slice();
  newClips[clipIndex] = {
    ...cur,
    ...(succeeded ? { description: generated } : {}),
    description_generated_at: new Date().toISOString(),
  };
  await db
    .update(assets)
    .set({
      payload: appendEditsLog({ ...payload, clips: newClips }, clipIndex, [
        'description_generated_at',
        ...(succeeded ? ['description'] : []),
      ]),
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, planAssetId));

  revalidatePath(`/packages/${plan.packageId}`);
  revalidatePath(`/packages/${plan.packageId}/shorts/${clipIndex}`);
  return generated;
}

// ─── description helpers (kept local — only used by generateClipDescription) ─

function numOr(obj: unknown, key: string, fallback: number): number {
  if (!obj || typeof obj !== 'object') return fallback;
  const v = (obj as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Pull the spoken text inside [startSec, endSec] from
 * `packages.intelligence.transcript.segments[].text`. Falls back to
 * "(transcript not available)" if the package has no transcript — the
 * LLM still has title + caption + tags to work from.
 */
function extractTranscriptInRange(intelligence: unknown, startSec: number, endSec: number): string {
  const transcript = (intelligence as { transcript?: unknown } | null)?.transcript;
  const segments = (transcript as { segments?: unknown } | undefined)?.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    return '(transcript not available)';
  }
  const overlapping: string[] = [];
  for (const raw of segments) {
    const s = raw as { start?: number; end?: number; text?: string };
    if (typeof s.start !== 'number' || typeof s.end !== 'number') continue;
    if (s.end <= startSec) continue;
    if (s.start >= endSec) break;
    if (typeof s.text === 'string' && s.text.trim()) overlapping.push(s.text.trim());
  }
  const joined = overlapping.join(' ');
  // Cap to keep prompt size reasonable — descriptions get ≤ 280 chars,
  // ~2k chars of context is plenty.
  return joined.length > 2000 ? `${joined.slice(0, 2000)}…` : joined || '(empty trim)';
}

/**
 * Strip code fences, surrounding quotes, leading labels ("Description:")
 * and trailing whitespace that some models like to wrap output in.
 * Caps to 280 chars (the TikTok hard limit + plays nice everywhere else).
 */
function cleanDescription(raw: string): string {
  let s = raw.trim();
  s = s
    .replace(/^```(?:[a-zA-Z0-9_-]*)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
  s = s
    .replace(/^["'""]/, '')
    .replace(/["'""]$/, '')
    .trim();
  s = s.replace(/^(?:description|caption|post|body)\s*[:\-—]\s*/i, '').trim();
  if (s.length > 280) s = `${s.slice(0, 277).trimEnd()}…`;
  return s;
}

// ─── deleteClip ───────────────────────────────────────────────────────────

/**
 * Mark a clip deleted on the plan. We keep the array index stable because
 * rendered assets and dispatch rows refer to `clip_index`. Any non-terminal
 * rendered counterpart is rejected/hidden; dispatched or published renders
 * are preserved for audit and lifecycle correctness.
 */
export async function deleteClip(planAssetId: string, clipIndex: number): Promise<void> {
  const { plan, payload, clips } = await loadPlanAndClip(planAssetId, clipIndex);

  const cur = (clips[clipIndex] ?? {}) as Record<string, unknown>;
  if (cur.deleted === true) return;

  const newClips = clips.slice();
  newClips[clipIndex] = {
    ...cur,
    deleted: true,
    deleted_at: new Date().toISOString(),
    pending_render: false,
  };
  await db
    .update(assets)
    .set({
      payload: appendEditsLog({ ...payload, clips: newClips }, clipIndex, ['deleted']),
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, planAssetId));

  const renderedRows = await db
    .select({ id: assets.id, status: assets.status, payload: assets.payload })
    .from(assets)
    .where(
      and(
        eq(assets.packageId, plan.packageId),
        eq(assets.type, renderedTypeForPlan(plan.type)),
        sql`(${assets.payload} ->> 'plan_asset_id') = ${planAssetId}`,
        sql`(${assets.payload} ->> 'clip_index')::int = ${clipIndex}`,
      ),
    );

  for (const rendered of renderedRows) {
    if (isTerminalRenderedStatus(rendered.status)) continue;
    await db
      .update(assets)
      .set({
        status: 'rejected',
        payload: {
          ...(rendered.payload as Record<string, unknown>),
          deleted: true,
          deleted_at: new Date().toISOString(),
        },
        updatedAt: sql`now()`,
      })
      .where(eq(assets.id, rendered.id));
  }

  revalidatePath(`/packages/${plan.packageId}`);
}
