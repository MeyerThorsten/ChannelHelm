'use server';

import { db } from '@/db/client';
import { assets, voiceExamples } from '@/db/schema';
import { GENERATABLE_TEXT_TYPES, type VoiceCountRow } from '@/lib/voice-types';
import { and, eq, inArray } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const ImportInput = z.object({
  brandId: z.string().regex(/^brd_/, 'brandId must start with brd_'),
  assetType: z.enum(GENERATABLE_TEXT_TYPES),
  texts: z.array(z.string()),
  score: z.number().min(0).max(1).optional(),
});

const BootstrapInput = z.object({
  brandId: z.string().regex(/^brd_/, 'brandId must start with brd_'),
  assetType: z.enum(GENERATABLE_TEXT_TYPES),
});

// Default score for manually seeded examples: above the generic floor (0.5)
// but below proven A/B winners (0.9 positive) so the pipeline rewards real
// performance over operator intuition once the signal loop warms up.
const DEFAULT_SEED_SCORE = 0.7;

// ---------------------------------------------------------------------------
// importVoiceExamples — operator pastes sample texts, one per line.
// ---------------------------------------------------------------------------

export async function importVoiceExamples(input: {
  brandId: string;
  assetType: string;
  texts: string[];
  score?: number;
}): Promise<{ inserted: number; skipped: number }> {
  const { brandId, assetType, texts, score = DEFAULT_SEED_SCORE } = ImportInput.parse(input);

  const candidates = texts.map((t) => t.trim()).filter((t) => t.length > 0);
  if (candidates.length === 0) return { inserted: 0, skipped: 0 };

  // Load all existing texts for this brand+type in one query to dedupe.
  const existing = await db
    .select({ text: voiceExamples.text })
    .from(voiceExamples)
    .where(and(eq(voiceExamples.brandId, brandId), eq(voiceExamples.assetType, assetType)));

  const existingSet = new Set(existing.map((r) => r.text));

  const toInsert = candidates.filter((t) => !existingSet.has(t));
  const skipped = candidates.length - toInsert.length;

  if (toInsert.length > 0) {
    await db.insert(voiceExamples).values(
      toInsert.map((text) => ({
        brandId,
        assetType,
        text,
        performanceScore: score,
        usedAsExampleCount: 0,
      })),
    );
  }

  revalidatePath(`/brands/${brandId}/voice`);
  return { inserted: toInsert.length, skipped };
}

// ---------------------------------------------------------------------------
// bootstrapFromPublishedAssets — seeds voice examples from existing
// approved/published assets without operator copy-paste.
// ---------------------------------------------------------------------------

export async function bootstrapFromPublishedAssets(input: {
  brandId: string;
  assetType: string;
}): Promise<{ inserted: number; skipped: number }> {
  const { brandId, assetType } = BootstrapInput.parse(input);

  const rows = await db
    .select({ payload: assets.payload })
    .from(assets)
    .where(
      and(
        eq(assets.brandId, brandId),
        eq(assets.type, assetType),
        inArray(assets.status, ['approved', 'published']),
      ),
    );

  if (rows.length === 0) return { inserted: 0, skipped: 0 };

  // Extract text using the same key-priority logic as promote_voice_examples.
  const candidates: string[] = [];
  for (const row of rows) {
    const text = extractTextFromPayload(row.payload);
    if (text && text.trim().length > 0) {
      candidates.push(text.trim());
    }
  }

  if (candidates.length === 0) return { inserted: 0, skipped: 0 };

  // Dedupe against existing rows.
  const existing = await db
    .select({ text: voiceExamples.text })
    .from(voiceExamples)
    .where(and(eq(voiceExamples.brandId, brandId), eq(voiceExamples.assetType, assetType)));

  const existingSet = new Set(existing.map((r) => r.text));

  // Also dedupe within the candidate list itself (two assets may have
  // identical text after trimming — rare but possible for titles).
  const seen = new Set<string>();
  const toInsert: string[] = [];
  for (const t of candidates) {
    if (!existingSet.has(t) && !seen.has(t)) {
      toInsert.push(t);
      seen.add(t);
    }
  }

  const skipped = candidates.length - toInsert.length;

  if (toInsert.length > 0) {
    await db.insert(voiceExamples).values(
      toInsert.map((text) => ({
        brandId,
        assetType,
        text,
        performanceScore: DEFAULT_SEED_SCORE,
        usedAsExampleCount: 0,
      })),
    );
  }

  revalidatePath(`/brands/${brandId}/voice`);
  return { inserted: toInsert.length, skipped };
}

// ---------------------------------------------------------------------------
// extractTextFromPayload — mirrors promote_voice_examples.ts::extractText.
// Kept in sync manually; the two callers have different contexts (worker vs
// server action) so we avoid a shared lib import to keep the Python/Node
// boundary clean.
// ---------------------------------------------------------------------------
function extractTextFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.tweet === 'string') return p.tweet;
  if (Array.isArray(p.posts)) return (p.posts as string[]).join('\n\n');
  if (Array.isArray(p.titles)) return (p.titles as string[]).join(' | ');
  if (Array.isArray(p.tags)) return (p.tags as string[]).join(', ');
  return null;
}

// ---------------------------------------------------------------------------
// Helpers for the UI — read-only queries
// ---------------------------------------------------------------------------

/**
 * Returns the count of voice examples per asset type for a given brand.
 * Used by the page to render the count column without a separate API route.
 */
export async function getVoiceExampleCounts(brandId: string): Promise<VoiceCountRow[]> {
  z.string().regex(/^brd_/).parse(brandId);

  // Drizzle doesn't expose GROUP BY natively for arbitrary columns without
  // `sql` helper; use a raw aggregate via sql`` to keep it Drizzle-idiomatic.
  const { sql, count } = await import('drizzle-orm');

  const rows = await db
    .select({
      assetType: voiceExamples.assetType,
      count: count(voiceExamples.id),
    })
    .from(voiceExamples)
    .where(eq(voiceExamples.brandId, brandId))
    .groupBy(voiceExamples.assetType)
    .orderBy(voiceExamples.assetType);

  // Satisfy the unused import
  void sql;

  return rows.map((r) => ({ assetType: r.assetType, count: Number(r.count) }));
}
