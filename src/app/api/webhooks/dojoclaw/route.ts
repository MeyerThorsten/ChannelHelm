import { createHash } from 'node:crypto';
import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { verifyHmac } from '@/lib/hmac';
import { processWebhookEvent } from '@/lib/webhook-processor';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const SIG_HEADER = process.env.DOJOCLAW_SIGNATURE_HEADER ?? 'x-dojoclaw-signature';
const SECRET = process.env.DOJOCLAW_WEBHOOK_SECRET;
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
  if (!check.ok) {
    return Response.json({ error: 'invalid_signature', reason: check.reason }, { status: 401 });
  }
  if (check.mode === 'unverified' && !warnedUnverified) {
    console.warn(
      '[webhook:dojoclaw] DOJOCLAW_WEBHOOK_SECRET not set — accepting unsigned webhooks. Set it to enforce signatures.',
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
