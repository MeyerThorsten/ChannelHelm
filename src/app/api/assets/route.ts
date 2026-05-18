import { db } from '@/db/client';
import { assets } from '@/db/schema';
import { parseQuery, withAuth } from '@/lib/http';
import { AssetListQuery } from '@/lib/schemas';
import { and, asc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Assets are produced by workers, not the API. List + by-id read/PATCH only.
export async function GET(req: Request) {
  return withAuth(req, async () => {
    const query = parseQuery(req, AssetListQuery);
    const filters = [eq(assets.packageId, query.packageId)];
    if (query.type) filters.push(eq(assets.type, query.type));
    if (query.status) filters.push(eq(assets.status, query.status));
    const rows = await db
      .select()
      .from(assets)
      .where(and(...filters))
      .orderBy(asc(assets.type));
    return Response.json({ assets: rows });
  });
}
