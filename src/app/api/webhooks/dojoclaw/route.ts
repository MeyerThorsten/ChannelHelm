import { createHash } from 'node:crypto';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { processWebhookEvent } from '@/lib/webhook-processor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * DojoClaw webhook receiver. Same idempotency contract as the Zernio
 * receiver — collision on `(source, source_event_id)` returns 200 with
 * `duplicate: true`. DojoClaw is on the LAN so HMAC verification can land
 * in v2 if needed; v1 accepts any body.
 */
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const explicit = typeof body.event_id === 'string' ? body.event_id : undefined;
  const sourceEventId = explicit ?? synthesizeId(body);
  const eventType = typeof body.event === 'string' ? body.event : 'unknown';
  const externalId = typeof body.job_id === 'string' ? body.job_id : null;

  try {
    const [row] = await db
      .insert(webhookEvents)
      .values({
        source: 'dojoclaw',
        sourceEventId,
        eventType,
        externalId,
        payload: body,
      })
      .returning({ id: webhookEvents.id });
    if (!row) throw new Error('webhook insert returned no row');

    const applied = await processWebhookEvent({
      webhookId: row.id,
      source: 'dojoclaw',
      eventType,
      externalId,
      payload: body,
    });
    return Response.json({ accepted: true, sourceEventId, applied });
  } catch (err) {
    if (err instanceof Error && /idx_webhook_source_event|unique/i.test(err.message)) {
      return Response.json({ accepted: true, duplicate: true, sourceEventId });
    }
    console.error('[webhook:dojoclaw]', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

function synthesizeId(body: Record<string, unknown>): string {
  const now = new Date();
  now.setSeconds(0, 0);
  const seed = JSON.stringify({
    source: 'dojoclaw',
    type: body.event ?? 'unknown',
    job: body.job_id ?? null,
    minute: now.toISOString(),
  });
  return `synth_${createHash('sha1').update(seed).digest('hex').slice(0, 16)}`;
}
