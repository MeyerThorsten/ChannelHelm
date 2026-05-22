import { db } from '@/db/client';
import { packages } from '@/db/schema';
import { notFound, parseJson, withAuth } from '@/lib/http';
import { PackageUpdate } from '@/lib/schemas';
import { and, eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

// §3 / #13: by-id routes are brand-scoped — require ?brandId= and include it
// in the WHERE so a caller can't read/mutate another brand's package.
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
      .from(packages)
      .where(and(eq(packages.id, id), eq(packages.brandId, bid)))
      .limit(1);
    if (!row) return notFound('package');
    return Response.json({ package: row });
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const bid = brandId(req);
    if (!bid) return Response.json({ error: 'brandId_required' }, { status: 400 });
    const body = await parseJson(req, PackageUpdate);
    if (Object.keys(body).length === 0) {
      return Response.json({ error: 'empty_patch' }, { status: 400 });
    }
    const values: Record<string, unknown> = { ...body, updatedAt: sql`now()` };
    if (body.approvedAt !== undefined) {
      values.approvedAt = body.approvedAt ? new Date(body.approvedAt) : null;
    }
    const [row] = await db
      .update(packages)
      .set(values)
      .where(and(eq(packages.id, id), eq(packages.brandId, bid)))
      .returning();
    if (!row) return notFound('package');
    return Response.json({ package: row });
  });
}
