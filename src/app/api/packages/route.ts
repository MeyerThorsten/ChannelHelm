import { db } from '@/db/client';
import { packages } from '@/db/schema';
import { parseJson, parseQuery, withAuth } from '@/lib/http';
import { PackageCreate, PackageListQuery } from '@/lib/schemas';
import { and, desc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const query = parseQuery(req, PackageListQuery);
    const filters = [eq(packages.brandId, query.brandId)];
    if (query.status) filters.push(eq(packages.status, query.status));
    if (query.sourceId) filters.push(eq(packages.sourceId, query.sourceId));
    const rows = await db
      .select()
      .from(packages)
      .where(and(...filters))
      .orderBy(desc(packages.updatedAt));
    return Response.json({ packages: rows });
  });
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    const body = await parseJson(req, PackageCreate);
    const [row] = await db.insert(packages).values(body).returning();
    return Response.json({ package: row }, { status: 201 });
  });
}
