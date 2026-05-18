import { db } from '@/db/client';
import { sources } from '@/db/schema';
import { notFound, withAuth } from '@/lib/http';
import { eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: Request, { params }: Ctx) {
  return withAuth(req, async () => {
    const { id } = await params;
    const [row] = await db.select().from(sources).where(eq(sources.id, id)).limit(1);
    if (!row) return notFound('source');
    return Response.json({ source: row });
  });
}
