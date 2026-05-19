import { createHash } from 'node:crypto';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { verifyHmac } from '@/lib/hmac';
import { processWebhookEvent } from '@/lib/webhook-processor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIG_HEADER = process.env.ZERNIO_SIGNATURE_HEADER ?? 'x-zernio-signature';
const SECRET = process.env.ZERNIO_WEBHOOK_SECRET;
let warnedUnverified = false;

/**
 * Zernio webhook receiver. Two-layer trust:
 *   1. HMAC-SHA256 of the raw body (when ZERNIO_WEBHOOK_SECRET is set —
 *      Zernio signs every callback; we reject anything that doesn't match).
 *   2. Unique index on (source, source_event_id) per §4: redelivered events
 *      collide and the receiver returns 200 with `duplicate: true`.
 *
 * When ZERNIO_WEBHOOK_SECRET is unset the receiver still accepts requests
 * (v1 may be deployed before Zernio publishes the secret) but logs a single
 * warning so it's visible the path is unverified.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const check = verifyHmac({
    secret: SECRET,
    headerName: SIG_HEADER,
    headerValue: req.headers.get(SIG_HEADER),
    rawBody: raw,
  });
  if (!check.ok) {
    return Response.json({ error: 'invalid_signature', reason: check.reason }, { status: 401 });
  }
  if (check.mode === 'unverified' && !warnedUnverified) {
    console.warn(
      '[webhook:zernio] ZERNIO_WEBHOOK_SECRET not set — accepting unsigned webhooks. Set it to enforce signatures.',
    );
    warnedUnverified = true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
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
    const [row] = await db
      .insert(webhookEvents)
      .values({
        source: 'zernio',
        sourceEventId,
        eventType,
        externalId,
        payload: body,
      })
      .returning({ id: webhookEvents.id });
    if (!row) throw new Error('webhook insert returned no row');

    const applied = await processWebhookEvent({
      webhookId: row.id,
      source: 'zernio',
      eventType,
      externalId,
      payload: body,
    });
    return Response.json({ accepted: true, sourceEventId, applied });
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
