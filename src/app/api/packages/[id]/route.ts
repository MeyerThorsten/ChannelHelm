import { db } from '@/db/client';
import { packages } from '@/db/schema';
import { notFound, parseJson, withAuth } from '@/lib/http';
import { PackageUpdate } from '@/lib/schemas';
import { eq, sql } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const [row] = await db.select().from(packages).where(eq(packages.id, id)).limit(1);
    if (!row) return notFound('package');
    return Response.json({ package: row });
  });
}

export async function PATCH(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const body = await parseJson(req, PackageUpdate);
    if (Object.keys(body).length === 0) {
      return Response.json({ error: 'empty_patch' }, { status: 400 });
    }
    const values: Record<string, unknown> = { ...body, updatedAt: sql`now()` };
    if (body.approvedAt !== undefined) {
      values.approvedAt = body.approvedAt ? new Date(body.approvedAt) : null;
    }
    const [row] = await db.update(packages).set(values).where(eq(packages.id, id)).returning();
    if (!row) return notFound('package');
    return Response.json({ package: row });
  });
}
