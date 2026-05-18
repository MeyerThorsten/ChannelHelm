import { db } from '@/db/client';
import { sources } from '@/db/schema';
import { parseJson, parseQuery, withAuth } from '@/lib/http';
import { SourceCreate, SourceListQuery } from '@/lib/schemas';
import { and, desc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const query = parseQuery(req, SourceListQuery);
    const filters = [eq(sources.brandId, query.brandId)];
    if (query.kind) filters.push(eq(sources.kind, query.kind));
    const rows = await db
      .select()
      .from(sources)
      .where(and(...filters))
      .orderBy(desc(sources.createdAt));
    return Response.json({ sources: rows });
  });
}

export async function POST(req: Request) {
  return withAuth(req, async () => {
    const body = await parseJson(req, SourceCreate);
    const [row] = await db.insert(sources).values(body).returning();
    return Response.json({ source: row }, { status: 201 });
  });
}
