import { z } from 'zod';
import { requireAuth } from './auth';

/**
 * Wraps a route handler with:
 *   - bearer-token auth (401/503 short-circuit)
 *   - ZodError → 400 with the issues list
 *   - any other throw → 500 with the message hidden
 */
export async function withAuth(req: Request, handler: () => Promise<Response>): Promise<Response> {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;
  try {
    return await handler();
  } catch (err) {
    if (err instanceof z.ZodError) {
      return Response.json({ error: 'validation', issues: err.issues }, { status: 400 });
    }
    console.error('[api]', err);
    return Response.json({ error: 'internal' }, { status: 500 });
  }
}

export function parseQuery<T extends z.ZodTypeAny>(req: Request, schema: T): z.infer<T> {
  const url = new URL(req.url);
  const obj: Record<string, string> = {};
  for (const [k, v] of url.searchParams.entries()) {
    // camelCase the API's brand_id / source_id / package_id query params so
    // they line up with the Drizzle column names and Zod schemas.
    const key = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
    obj[key] = v;
  }
  return schema.parse(obj);
}

export async function parseJson<T extends z.ZodTypeAny>(
  req: Request,
  schema: T,
): Promise<z.infer<T>> {
  const body = await req.json().catch(() => {
    throw new z.ZodError([{ code: 'custom', message: 'invalid JSON body', path: [] }]);
  });
  return schema.parse(body);
}

export function notFound(resource: string): Response {
  return Response.json({ error: 'not_found', resource }, { status: 404 });
}
