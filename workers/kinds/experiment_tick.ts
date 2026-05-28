/**
 * §13 (v1.5 — Helm Signal). Self-run title/thumbnail A/B rotation. One tick
 * advances ONE experiment's state machine:
 *
 *   draft   → apply variant A to the live video, go `running`.
 *   running → if the current variant's window (`rotation_hours`) has elapsed,
 *             read its performance from the YouTube Analytics API, store the
 *             observation, then either rotate to the next variant / next round,
 *             or — once every variant has run `rounds` times and cleared
 *             `min_views` — pick the winner, apply it permanently, mark
 *             `decided`, and feed the result into `voice_examples`.
 *
 * Native YouTube "Test & Compare" is not in the Data API; this rotates the
 * title (videos.update) and thumbnail (thumbnails.set) ourselves and decides
 * on YouTube Analytics metrics. Idempotency: the recurring enqueuer keys ticks
 * by `experiment_tick:{id}:{hour}` and launch keys by `:launch`; all the
 * state transitions are guarded by `current_variant_since`, so a duplicate
 * tick within a window is a no-op.
 */
import { db } from '@/db/client';
import { type ExperimentObservation, experiments, voiceExamples } from '@/db/schema';
import { type DecisionMetric, decideWinner } from '@/lib/ab-decision';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { applyVideoVariant, fetchVideoAnalytics } from '../integrations/youtube';
import type { JobRow } from '../queue';

const Payload = z.object({ experimentId: z.string().regex(/^exp_/) });

type Experiment = typeof experiments.$inferSelect;

const redirectUri = (): string =>
  `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}/api/youtube/oauth/callback`;

const isoDate = (d: Date): string => d.toISOString().slice(0, 10);

export async function run(job: JobRow): Promise<void> {
  const { experimentId } = Payload.parse(job.payload);
  const [exp] = await db
    .select()
    .from(experiments)
    .where(eq(experiments.id, experimentId))
    .limit(1);
  if (!exp) throw new Error(`experiment_tick: ${experimentId} not found`);

  if (exp.status === 'decided' || exp.status === 'cancelled' || exp.status === 'error') {
    console.log(`[experiment_tick] ${exp.id} is ${exp.status} — nothing to do`);
    return;
  }
  if (!exp.variants || exp.variants.length < 2) {
    await markError(exp.id, 'experiment needs at least 2 variants');
    return;
  }

  try {
    // ── START: draft → variant A live, running ───────────────────────────
    if (exp.status === 'draft' || exp.currentVariant == null) {
      await applyVariant(exp, 0);
      await db
        .update(experiments)
        .set({
          status: 'running',
          currentVariant: 0,
          currentCycle: 0,
          currentVariantSince: sql`now()`,
          startedAt: sql`now()`,
          lastError: null,
          updatedAt: sql`now()`,
        })
        .where(eq(experiments.id, exp.id));
      console.log(`[experiment_tick] ${exp.id} started — variant ${exp.variants[0]?.label} live`);
      return;
    }

    // ── RUNNING: has the current window elapsed? ─────────────────────────
    const sinceMs = exp.currentVariantSince ? new Date(exp.currentVariantSince).getTime() : 0;
    const elapsedHours = (Date.now() - sinceMs) / 3_600_000;
    if (elapsedHours < exp.rotationHours) {
      console.log(
        `[experiment_tick] ${exp.id} variant ${exp.currentVariant} window ` +
          `${elapsedHours.toFixed(1)}/${exp.rotationHours}h — waiting`,
      );
      return;
    }

    // Window closed: read analytics for it, append the observation.
    const observation = await observeWindow(exp);
    const variants = structuredClone(exp.variants);
    const cur = variants[exp.currentVariant];
    if (!cur) throw new Error(`current variant ${exp.currentVariant} missing`);
    cur.observations.push(observation);

    const isLastVariant = exp.currentVariant >= variants.length - 1;

    if (isLastVariant) {
      const decision = decideWinner(variants, {
        metric: exp.metric as DecisionMetric,
        requiredCycles: exp.rounds,
        minViews: exp.minViews,
      });
      if (decision.decided) {
        await applyVariant({ ...exp, variants }, decision.winnerVariant);
        await db
          .update(experiments)
          .set({
            status: 'decided',
            winnerVariant: decision.winnerVariant,
            currentVariant: decision.winnerVariant,
            variants,
            decidedAt: sql`now()`,
            currentVariantSince: sql`now()`,
            lastError: null,
            updatedAt: sql`now()`,
          })
          .where(eq(experiments.id, exp.id));
        await writeFeedback(exp, variants, decision.winnerVariant);
        const winLabel = variants[decision.winnerVariant]?.label;
        console.log(`[experiment_tick] ${exp.id} DECIDED — winner variant ${winLabel}`);
        return;
      }
      // Not decided yet → start another round from variant A.
      await rotateTo(exp, variants, 0, exp.currentCycle + 1, decision.reason);
      return;
    }

    // Mid-round → advance to the next variant, same cycle.
    await rotateTo(exp, variants, exp.currentVariant + 1, exp.currentCycle, null);
  } catch (err) {
    const msg = (err as Error).message;
    await db
      .update(experiments)
      .set({ lastError: msg.slice(0, 500), updatedAt: sql`now()` })
      .where(eq(experiments.id, exp.id));
    // Connection/config problems are fatal; transient API errors should retry.
    if (/no YouTube connection|not connected|insufficient|invalid_grant|forbidden/i.test(msg)) {
      await markError(exp.id, msg);
      return;
    }
    throw err; // let the queue retry transient failures
  }
}

async function rotateTo(
  exp: Experiment,
  variants: Experiment['variants'],
  nextVariant: number,
  nextCycle: number,
  reason: string | null,
): Promise<void> {
  await applyVariant({ ...exp, variants }, nextVariant);
  await db
    .update(experiments)
    .set({
      variants,
      currentVariant: nextVariant,
      currentCycle: nextCycle,
      currentVariantSince: sql`now()`,
      lastError: reason,
      updatedAt: sql`now()`,
    })
    .where(eq(experiments.id, exp.id));
  console.log(
    `[experiment_tick] ${exp.id} rotated → variant ${variants[nextVariant]?.label} (cycle ${nextCycle})${reason ? ` [${reason}]` : ''}`,
  );
}

async function applyVariant(exp: Experiment, index: number): Promise<void> {
  const v = exp.variants[index];
  if (!v) throw new Error(`applyVariant: variant ${index} missing`);
  await applyVideoVariant({
    brandId: exp.brandId,
    redirectUri: redirectUri(),
    videoId: exp.videoId,
    title: v.title ?? null,
    thumbnailPath: v.thumbnail_path ?? null,
  });
}

async function observeWindow(exp: Experiment): Promise<ExperimentObservation> {
  const since = exp.currentVariantSince ? new Date(exp.currentVariantSince) : new Date();
  const now = new Date();
  const days = Math.max(1, Math.round((now.getTime() - since.getTime()) / 86_400_000));
  const a = await fetchVideoAnalytics({
    brandId: exp.brandId,
    redirectUri: redirectUri(),
    videoId: exp.videoId,
    startDate: isoDate(since),
    endDate: isoDate(now),
  });
  return {
    cycle: exp.currentCycle,
    started_at: since.toISOString(),
    ended_at: now.toISOString(),
    days,
    views: a.views,
    estimated_minutes_watched: a.estimatedMinutesWatched,
    average_view_percentage: a.averageViewPercentage,
    impressions: a.impressions,
    impression_ctr: a.impressionCtr,
  };
}

/**
 * Close the loop: the winning title becomes a positive voice example (so future
 * generate_asset runs favour it); losing titles get a low score. Thumbnail-only
 * experiments have no text channel in v1, so they record nothing here.
 */
async function writeFeedback(
  exp: Experiment,
  variants: Experiment['variants'],
  winnerVariant: number,
): Promise<void> {
  const assetType = 'youtube_title_set';
  for (const v of variants) {
    const title = v.title?.trim();
    if (!title) continue;
    const score = v.variant_index === winnerVariant ? 0.9 : 0.1;
    const existing = await db
      .select({ id: voiceExamples.id })
      .from(voiceExamples)
      .where(
        and(
          eq(voiceExamples.brandId, exp.brandId),
          eq(voiceExamples.assetType, assetType),
          eq(voiceExamples.text, title),
        ),
      )
      .limit(1);
    if (existing[0]) {
      await db
        .update(voiceExamples)
        .set({ performanceScore: score })
        .where(eq(voiceExamples.id, existing[0].id));
    } else {
      await db
        .insert(voiceExamples)
        .values({ brandId: exp.brandId, assetType, text: title, performanceScore: score });
    }
  }
}

async function markError(id: string, msg: string): Promise<void> {
  await db
    .update(experiments)
    .set({ status: 'error', lastError: msg.slice(0, 500), updatedAt: sql`now()` })
    .where(eq(experiments.id, id));
  console.warn(`[experiment_tick] ${id} marked error: ${msg}`);
}
