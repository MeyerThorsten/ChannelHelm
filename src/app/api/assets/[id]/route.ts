import { db } from '@/db/client';
import { assets } from '@/db/schema';
import { notFound, parseJson, withAuth } from '@/lib/http';
import { AssetUpdate } from '@/lib/schemas';
import { enqueue } from '@workers/queue';
import { and, eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// §3 / #13: assets are brand-scoped via assets.brand_id — require ?brandId=.
function brandId(req: Request): string | null {
  return new URL(req.url).searchParams.get('brandId');
}

export async function GET(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const bid = brandId(req);
    if (!bid) return Response.json({ error: 'brandId_required' }, { status: 400 });
    const [row] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.brandId, bid)))
      .limit(1);
    if (!row) return notFound('asset');
    return Response.json({ asset: row });
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const bid = brandId(req);
    if (!bid) return Response.json({ error: 'brandId_required' }, { status: 400 });
    const body = await parseJson(req, AssetUpdate);
    if (Object.keys(body).length === 0) {
      return Response.json({ error: 'empty_patch' }, { status: 400 });
    }
    const [before] = await db
      .select()
      .from(assets)
      .where(and(eq(assets.id, id), eq(assets.brandId, bid)))
      .limit(1);
    if (!before) return notFound('asset');

    const [row] = await db
      .update(assets)
      .set({ ...body, updatedAt: sql`now()` })
      .where(and(eq(assets.id, id), eq(assets.brandId, bid)))
      .returning();
    if (!row) return notFound('asset');

    // Approval-transition side-effects, mirroring the Server Action so
    // PATCH /api/assets/:id and the dashboard's Approve button behave
    // identically. Triggers only on the draft|ready_for_review → approved
    // transition; idempotent because the queue's idempotency key prevents
    // duplicate jobs.
    const becameApproved =
      body.status === 'approved' && before.status !== 'approved' && row.status === 'approved';
    if (becameApproved) {
      const enqueued: { kind: string; id: number; created: boolean }[] = [];
      if (row.type.endsWith('_plan')) {
        const clips = (row.payload as { clips?: unknown[] }).clips ?? [];
        for (let i = 0; i < clips.length; i++) {
          const r = await enqueue({
            kind: 'clip_render',
            payload: { planAssetId: row.id, clipIndex: i },
            idempotencyKey: `clip_render:${row.id}:${i}`,
          });
          enqueued.push({ kind: 'clip_render', id: r.id, created: r.created });
        }
      } else {
        const r = await enqueue({
          kind: 'dispatch',
          payload: { assetId: row.id },
          idempotencyKey: `dispatch:${row.id}`,
        });
        enqueued.push({ kind: 'dispatch', id: r.id, created: r.created });
      }
      return Response.json({ asset: row, enqueued });
    }
    return Response.json({ asset: row });
  });
}
