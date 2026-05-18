import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { parseJson, parseQuery, withAuth } from '@/lib/http';
import { BrandCreate, BrandListQuery } from '@/lib/schemas';
import { asc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const query = parseQuery(req, BrandListQuery);
    const rows = await db
      .select()
      .from(brands)
      .where(query.active === undefined ? undefined : eq(brands.active, query.active))
      .orderBy(asc(brands.slug));
    return Response.json({ brands: rows });
  });
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    const body = await parseJson(req, BrandCreate);
    const [row] = await db.insert(brands).values(body).returning();
    return Response.json({ brand: row }, { status: 201 });
  });
}
