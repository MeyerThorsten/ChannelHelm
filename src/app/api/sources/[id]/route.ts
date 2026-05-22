import { db } from '@/db/client';
import { sources } from '@/db/schema';
import { notFound, withAuth } from '@/lib/http';
import { and, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    // §3 / #13: brand-scoped by-id read.
    const bid = new URL(req.url).searchParams.get('brandId');
    if (!bid) return Response.json({ error: 'brandId_required' }, { status: 400 });
    const [row] = await db
      .select()
      .from(sources)
      .where(and(eq(sources.id, id), eq(sources.brandId, bid)))
      .limit(1);
    if (!row) return notFound('source');
    return Response.json({ source: row });
  });
}
