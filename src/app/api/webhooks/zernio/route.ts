import { createHash } from 'node:crypto';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Zernio webhook receiver. Idempotency on `(source, source_event_id)` per
 * §4: redelivered events collide on the unique index and the receiver
 * returns 200 with `duplicate: true`.
 *
 * No bearer auth — Zernio is external. v2 will require HMAC verification
 * using a shared secret; for v1 we accept any body and rely on the unique
 * constraint as the only correctness gate.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const sourceEventId = typeof body._id === 'string' ? body._id : synthesizeId('zernio', body);
  const eventType = typeof body.event === 'string' ? body.event : 'unknown';
  const externalId =
    typeof body.post_id === 'string'
      ? body.post_id
      : typeof body.postId === 'string'
        ? body.postId
        : null;

  try {
    await db.insert(webhookEvents).values({
      source: 'zernio',
      sourceEventId,
      eventType,
      externalId,
      payload: body,
    });
    return Response.json({ accepted: true, sourceEventId });
  } catch (err) {
    // Unique-index collision = duplicate redelivery. Swallow and 200.
    if (err instanceof Error && /idx_webhook_source_event|unique/i.test(err.message)) {
      return Response.json({ accepted: true, duplicate: true, sourceEventId });
    }
    console.error('[webhook:zernio]', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

function synthesizeId(source: string, body: Record<string, unknown>): string {
  // Per §4, if a webhook lacks a stable source_event_id, hash the event
  // type + external id + minute-floored timestamp to get a deterministic id.
  const now = new Date();
  now.setSeconds(0, 0);
  const seed = JSON.stringify({
    source,
    type: body.event ?? 'unknown',
    extern: body.post_id ?? body.postId ?? null,
    minute: now.toISOString(),
  });
  return `synth_${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}
