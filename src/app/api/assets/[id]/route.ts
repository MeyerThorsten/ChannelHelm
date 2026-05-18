import { db } from '@/db/client';
import { assets } from '@/db/schema';
import { notFound, parseJson, withAuth } from '@/lib/http';
import { AssetUpdate } from '@/lib/schemas';
import { eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const [row] = await db.select().from(assets).where(eq(assets.id, id)).limit(1);
    if (!row) return notFound('asset');
    return Response.json({ asset: row });
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const body = await parseJson(req, AssetUpdate);
    if (Object.keys(body).length === 0) {
      return Response.json({ error: 'empty_patch' }, { status: 400 });
    }
    const [row] = await db
      .update(assets)
      .set({ ...body, updatedAt: sql`now()` })
      .where(eq(assets.id, id))
      .returning();
    if (!row) return notFound('asset');
    return Response.json({ asset: row });
  });
}
