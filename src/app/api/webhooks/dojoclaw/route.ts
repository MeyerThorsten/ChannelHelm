import { createHash } from 'node:crypto';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { verifyHmac, webhookGate } from '@/lib/hmac';
import { processWebhookEvent } from '@/lib/webhook-processor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIG_HEADER = process.env.DOJOCLAW_SIGNATURE_HEADER ?? 'x-dojoclaw-signature';
const SECRET = process.env.DOJOCLAW_WEBHOOK_SECRET;
const ALLOW_UNSIGNED = process.env.ALLOW_UNSIGNED_WEBHOOKS === '1';
let warnedUnverified = false;

/**
 * DojoClaw webhook receiver. Same idempotency contract as the Zernio
 * receiver. HMAC verification when DOJOCLAW_WEBHOOK_SECRET is set;
 * unsigned-but-accepted (with a one-shot console warning) otherwise.
 */
export async function POST(req: Request) {
  const raw = await req.text();
  const check = verifyHmac({
    secret: SECRET,
    headerName: SIG_HEADER,
    headerValue: req.headers.get(SIG_HEADER),
    rawBody: raw,
  });
  const gate = webhookGate(check, ALLOW_UNSIGNED);
  if (!gate.accept) {
    return Response.json(gate.body, { status: gate.status });
  }
  if (gate.mode === 'unverified' && !warnedUnverified) {
    console.warn(
      '[webhook:dojoclaw] ALLOW_UNSIGNED_WEBHOOKS=1 — accepting UNSIGNED webhooks. Set DOJOCLAW_WEBHOOK_SECRET and remove the override before exposing this route.',
    );
    warnedUnverified = true;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw) as Record<string, unknown>;
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
