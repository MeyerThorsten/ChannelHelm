import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { parseJson, withAuth } from '@/lib/http';
import { JobEnqueue } from '@/lib/schemas';
import { enqueue } from '@workers/queue';
import { and, desc, eq } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// POST /api/jobs — enqueue a job. The ONLY way to add rows to `jobs` from
// outside the worker layer is via `workers/queue.ts::enqueue`. This route
// just adapts an HTTP body to that call.
export async function POST(req: Request) {
  return withAuth(req, async () => {
    const body = await parseJson(req, JobEnqueue);
    const result = await enqueue({
      kind: body.kind,
      payload: body.payload,
      idempotencyKey: body.idempotencyKey,
      priority: body.priority,
      runAfter: body.runAfter ? new Date(body.runAfter) : undefined,
    });
    return Response.json(
      { job: { id: result.id, created: result.created } },
      { status: result.created ? 201 : 200 },
    );
  });
}

// GET /api/jobs?kind=noop&status=done — small dev/inspection endpoint. The
// dashboard will replace this with proper filters later.
export async function GET(req: Request) {
  return withAuth(req, async () => {
    const url = new URL(req.url);
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');
    const filters = [
      kind ? eq(jobs.kind, kind) : null,
      status ? eq(jobs.status, status) : null,
    ].filter((f): f is NonNullable<typeof f> => f !== null);
    const where = filters.length === 0 ? undefined : and(...filters);
    const rows = await db.select().from(jobs).where(where).orderBy(desc(jobs.id)).limit(50);
    return Response.json({ jobs: rows });
  });
}
