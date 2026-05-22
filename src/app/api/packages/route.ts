import { db } from '@/db/client';
import { packages, sources } from '@/db/schema';
import { parseJson, parseQuery, withAuth } from '@/lib/http';
import { PackageCreate, PackageListQuery } from '@/lib/schemas';
import { enqueue } from '@workers/queue';
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
    // §3 / #1: a package's brand must match its source's brand. Verify before
    // insert (the DB composite FK is the backstop). Prevents cross-brand media
    // / voice / routing contamination.
    const [src] = await db
      .select({ brandId: sources.brandId })
      .from(sources)
      .where(eq(sources.id, body.sourceId))
      .limit(1);
    if (!src) return Response.json({ error: 'source_not_found' }, { status: 404 });
    if (src.brandId !== body.brandId) {
      return Response.json(
        {
          error: 'brand_source_mismatch',
          detail: `source ${body.sourceId} belongs to brand ${src.brandId}, not ${body.brandId}`,
        },
        { status: 409 },
      );
    }
    const [row] = await db.insert(packages).values(body).returning();
    if (!row) throw new Error('package insert returned no row');
    // Auto-enqueue the first pipeline step. Idempotency key is `ingest:{source_id}`
    // per §4 — re-creating a package for the same source replays the same job id.
    const job = await enqueue({
      kind: 'ingest',
      payload: { sourceId: row.sourceId, packageId: row.id },
      idempotencyKey: `ingest:${row.sourceId}`,
    });
    return Response.json({ package: row, ingestJob: job }, { status: 201 });
  });
}
