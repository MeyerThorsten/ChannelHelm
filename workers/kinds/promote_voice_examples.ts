import { db } from '@/db/client';
import { assets, voiceExamples } from '@/db/schema';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { JobRow } from '../queue';

const Payload = z.object({
  brandId: z.string().regex(/^brd_/),
  assetType: z.string().min(1),
  topPercentile: z.number().min(0).max(1).optional(),
});

/**
 * §13 step 17. Reads the per-asset-type performance distribution from the
 * `signals` table (populated by collect_signal), surfaces the top-decile
 * assets, and inserts/refreshes corresponding rows in `voice_examples` so
 * subsequent generate_asset runs see them as few-shot exemplars.
 *
 * Idempotent: re-running just updates `performance_score` on existing rows
 * (matched by brand + asset_type + exact text).
 */
export async function run(job: JobRow): Promise<void> {
  const { brandId, assetType, topPercentile = 0.1 } = Payload.parse(job.payload);

  // Score per asset = normalized signal in [0, 1]. The signals table can hold
  // multiple metrics; we use the latest sample of `engagement` if present,
  // else `impressions` as a fallback. Both are coerced into a normalized
  // score against this brand+type's distribution.
  const scoresQuery = await db.execute(
    sql`
      WITH latest AS (
        SELECT s.asset_id, s.metric, s.value,
               row_number() OVER (
                 PARTITION BY s.asset_id, s.metric ORDER BY s.sampled_at DESC
               ) AS rn
          FROM signals s
         WHERE s.brand_id = ${brandId}
      ),
      pick AS (
        SELECT asset_id,
               max(CASE WHEN metric = 'engagement' THEN value END) AS engagement,
               max(CASE WHEN metric = 'impressions' THEN value END) AS impressions
          FROM latest
         WHERE rn = 1
         GROUP BY asset_id
      )
      SELECT a.id, a.payload, COALESCE(p.engagement, p.impressions, 0) AS raw_score
        FROM assets a
        LEFT JOIN pick p ON p.asset_id = a.id
       WHERE a.brand_id = ${brandId}
         AND a.type = ${assetType}
         AND a.status IN ('approved','published')
    `,
  );

  // Cast through unknown — node-postgres returns rows on .rows
  const rows =
    (
      scoresQuery as unknown as {
        rows: { id: string; payload: unknown; raw_score: string | number }[];
      }
    ).rows ?? [];
  if (rows.length === 0) {
    console.log(
      `[promote_voice_examples] brand=${brandId} type=${assetType}: no scored assets, nothing to do`,
    );
    return;
  }

  // Normalize raw_score → [0, 1] across this batch.
  const scores = rows.map((r) => Number(r.raw_score) || 0);
  const max = Math.max(...scores, 1);
  const normalized = scores.map((s) => s / max);

  // Pick the top decile (at least 1, at most 20).
  const ranked = rows
    .map((r, i) => ({ row: r, score: normalized[i] ?? 0 }))
    .sort((a, b) => b.score - a.score);
  const cutoffIdx = Math.max(1, Math.min(20, Math.floor(rows.length * topPercentile)));
  const top = ranked.slice(0, cutoffIdx);

  let inserted = 0;
  let updated = 0;
  for (const { row, score } of top) {
    const text = extractText(row.payload);
    if (!text) continue;

    const existing = await db
      .select({ id: voiceExamples.id })
      .from(voiceExamples)
      .where(
        and(
          eq(voiceExamples.brandId, brandId),
          eq(voiceExamples.assetType, assetType),
          eq(voiceExamples.text, text),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await db
        .update(voiceExamples)
        .set({ performanceScore: score })
        .where(eq(voiceExamples.id, existing[0].id));
      updated++;
    } else {
      await db.insert(voiceExamples).values({
        brandId,
        assetType,
        text,
        performanceScore: score,
        usedAsExampleCount: 0,
      });
      inserted++;
    }
  }

  console.log(
    `[promote_voice_examples] brand=${brandId} type=${assetType}: ` +
      `inserted=${inserted} updated=${updated} (top ${cutoffIdx} of ${rows.length} scored)`,
  );

  // Touch voiceExamples.assets is intentional — Drizzle won't tree-shake the
  // import if we don't reference it elsewhere.
  void assets;
  void gte;
  void desc;
}

/**
 * Pull the most representative text out of an asset payload. Different asset
 * types use different keys; we try a few in order.
 */
function extractText(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.text === 'string') return p.text;
  if (typeof p.tweet === 'string') return p.tweet;
  if (Array.isArray(p.posts)) return p.posts.join('\n\n');
  if (Array.isArray(p.titles)) return (p.titles as string[]).join(' | ');
  if (Array.isArray(p.tags)) return (p.tags as string[]).join(', ');
  return null;
}
