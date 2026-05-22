'use server';

import { db } from '@/db/client';
import { assets } from '@/db/schema';
import { generateAssetContent, upsertSectionAsset } from '@workers/lib/generate';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

/**
 * Generate a single section (e.g. youtube_title_set) on demand from the
 * studio. Ensures the upstream scene_log + analysis exist (built inline from
 * the transcript if the visual stage hasn't finished), then upserts the
 * asset. Same documented "LLM in a Server Action" carve-out as regenerate.
 */
// #21: per-section generation is only for these Content Studio sections.
// Package-wide asset production stays the worker's job (generate_asset).
const SECTION_TYPES = new Set(['youtube_title_set', 'youtube_description', 'youtube_tags']);

export async function generateSection(packageId: string, assetType: string): Promise<void> {
  if (!SECTION_TYPES.has(assetType)) {
    throw new Error(`generateSection: "${assetType}" is not a Content Studio section type`);
  }
  await upsertSectionAsset(packageId, assetType);
  revalidatePath(`/packages/${packageId}`);
}

/**
 * Interactive single-asset regeneration. Runs the LLM call SYNCHRONOUSLY in
 * the Server Action (a deliberate, documented carve-out from "no LLM in
 * Server Actions" — see CLAUDE.md). This keeps the studio's per-section
 * Regenerate snappy and self-contained: no dependency on a running
 * generate_asset worker. The bulk pipeline still uses the queue.
 *
 * On success the asset row's payload + provenance are replaced and its
 * status reset to ready_for_review. On any LLM/parse failure the row is left
 * untouched and the error propagates to the caller (the card surfaces it).
 */
export async function regenerateAsset(assetId: string): Promise<void> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`regenerateAsset: ${assetId} not found`);

  const { payload, provenance } = await generateAssetContent({
    packageId: asset.packageId,
    assetType: asset.type,
  });

  await db
    .update(assets)
    .set({
      payload,
      provenance,
      status: 'ready_for_review',
      updatedAt: sql`now()`,
    })
    .where(eq(assets.id, assetId));

  revalidatePath(`/packages/${asset.packageId}`);
}

/**
 * Save an operator's manual edit to an asset payload (inline editing in the
 * studio cards). No LLM — just persists the new payload.
 */
export async function saveAssetPayload(
  assetId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const [asset] = await db.select().from(assets).where(eq(assets.id, assetId)).limit(1);
  if (!asset) throw new Error(`saveAssetPayload: ${assetId} not found`);
  await db.update(assets).set({ payload, updatedAt: sql`now()` }).where(eq(assets.id, assetId));
  revalidatePath(`/packages/${asset.packageId}`);
}
