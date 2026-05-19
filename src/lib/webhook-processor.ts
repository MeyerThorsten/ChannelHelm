import { db } from '@/db/client';
import { assets, signals, webhookEvents } from '@/db/schema';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Apply the side-effects of a webhook event after it's been recorded.
 *
 * Runs inline in the receiver (small DB-only work; no long-running tasks),
 * so a webhook caller sees the asset row updated by the time the receiver
 * returns 200. Idempotency is guaranteed by the unique index on
 * (source, source_event_id) — duplicate deliveries collide at INSERT time
 * and never reach this function.
 *
 * Returns true when the event mapped to a known transition, false when the
 * event was recorded but had no asset-side effect (e.g. unknown event type).
 */
export async function processWebhookEvent(opts: {
  webhookId: number;
  source: 'zernio' | 'dojoclaw';
  eventType: string;
  externalId: string | null;
  payload: Record<string, unknown>;
}): Promise<boolean> {
  const { webhookId, source, eventType, externalId, payload } = opts;
  let applied = false;

  if (source === 'zernio') {
    applied = await processZernio(eventType, externalId, payload);
  } else if (source === 'dojoclaw') {
    applied = await processDojoclaw(eventType, externalId, payload);
  }

  await db
    .update(webhookEvents)
    .set({ processed: true, processedAt: sql`now()` })
    .where(eq(webhookEvents.id, webhookId));
  return applied;
}

async function processZernio(
  eventType: string,
  externalId: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!externalId) return false;
  const asset = await findAssetByExternalId('zernio', externalId);
  if (!asset) return false;

  if (eventType === 'post.published') {
    const publishedAt =
      typeof payload.published_at === 'string' ? payload.published_at : new Date().toISOString();
    const dispatch = { ...(asset.dispatch as Record<string, unknown>), published_at: publishedAt };
    await db
      .update(assets)
      .set({ status: 'published', dispatch, updatedAt: sql`now()` })
      .where(eq(assets.id, asset.id));
    return true;
  }
  if (eventType === 'post.failed') {
    const dispatch = {
      ...(asset.dispatch as Record<string, unknown>),
      error: typeof payload.error === 'string' ? payload.error : 'zernio post failed',
    };
    await db
      .update(assets)
      .set({ status: 'failed', dispatch, updatedAt: sql`now()` })
      .where(eq(assets.id, asset.id));
    return true;
  }
  if (eventType === 'post.analytics' || eventType === 'analytics.update') {
    // Inline analytics drop — write whatever metrics arrived into `signals`
    // so the dashboard sees them without waiting for the next collect_signal
    // run.
    const metrics: Record<string, number | undefined> = {
      impressions: numOrU(payload.impressions),
      engagement: numOrU(payload.engagement),
      ctr: numOrU(payload.ctr),
    };
    const sampledAt = new Date(
      typeof payload.sampled_at === 'string' ? payload.sampled_at : new Date().toISOString(),
    );
    let wrote = false;
    for (const [metric, value] of Object.entries(metrics)) {
      if (value === undefined) continue;
      await db.insert(signals).values({
        brandId: asset.brandId,
        assetId: asset.id,
        sourceSignal: 'zernio',
        metric,
        value,
        sampledAt,
      });
      wrote = true;
    }
    if (wrote) {
      await db
        .update(assets)
        .set({
          signals: {
            ...(asset.signals as Record<string, unknown>),
            ...Object.fromEntries(Object.entries(metrics).filter(([, v]) => v !== undefined)),
            last_sampled_at: sampledAt.toISOString(),
          },
          updatedAt: sql`now()`,
        })
        .where(eq(assets.id, asset.id));
    }
    return wrote;
  }
  return false;
}

async function processDojoclaw(
  eventType: string,
  externalId: string | null,
  payload: Record<string, unknown>,
): Promise<boolean> {
  if (!externalId) return false;
  const asset = await findAssetByExternalId('dojoclaw', externalId);
  if (!asset) return false;

  if (eventType === 'article.completed') {
    const draftUrl = typeof payload.draft_url === 'string' ? payload.draft_url : null;
    const dispatch = {
      ...(asset.dispatch as Record<string, unknown>),
      draft_url: draftUrl,
      completed_at: new Date().toISOString(),
    };
    await db
      .update(assets)
      .set({ status: 'published', dispatch, updatedAt: sql`now()` })
      .where(eq(assets.id, asset.id));
    return true;
  }
  if (eventType === 'article.failed') {
    const dispatch = {
      ...(asset.dispatch as Record<string, unknown>),
      error: typeof payload.error === 'string' ? payload.error : 'dojoclaw article failed',
    };
    await db
      .update(assets)
      .set({ status: 'failed', dispatch, updatedAt: sql`now()` })
      .where(eq(assets.id, asset.id));
    return true;
  }
  return false;
}

async function findAssetByExternalId(target: 'zernio' | 'dojoclaw', externalId: string) {
  // Assets carry `dispatch->>'external_id'` populated by the dispatch worker.
  // The §4 partial index makes this lookup an index scan.
  const rows = await db
    .select()
    .from(assets)
    .where(
      and(
        sql`(${assets.dispatch} ->> 'external_id') = ${externalId}`,
        sql`(${assets.dispatch} ->> 'target') = ${target}`,
      ),
    )
    .limit(1);
  return rows[0];
}

function numOrU(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}
