import { db } from '@/db/client';
import { webhookEvents } from '@/db/schema';
import { and, desc, eq } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ source?: string; processed?: string }>;
const SOURCES = ['zernio', 'dojoclaw'] as const;

export default async function WebhooksPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters = [];
  if (params.source) filters.push(eq(webhookEvents.source, params.source));
  if (params.processed === 'true') filters.push(eq(webhookEvents.processed, true));
  if (params.processed === 'false') filters.push(eq(webhookEvents.processed, false));
  const where = filters.length === 0 ? undefined : and(...filters);

  const rows = await db
    .select()
    .from(webhookEvents)
    .where(where)
    .orderBy(desc(webhookEvents.receivedAt))
    .limit(100);

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Webhook events</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Inbound from Zernio + DojoClaw. Latest 100. Receiver is idempotent on{' '}
          <code>(source, source_event_id)</code>.
        </p>
      </header>

      <form className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="text-sm">
          <span className="block text-zinc-700 dark:text-zinc-300">source</span>
          <select
            name="source"
            defaultValue={params.source ?? ''}
            className="mt-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all</option>
            {SOURCES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-zinc-700 dark:text-zinc-300">processed</span>
          <select
            name="processed"
            defaultValue={params.processed ?? ''}
            className="mt-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all</option>
            <option value="true">yes</option>
            <option value="false">no</option>
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
        >
          Filter
        </button>
        <a href="/webhooks" className="text-sm text-zinc-500 hover:underline">
          reset
        </a>
      </form>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left">received</th>
              <th className="px-3 py-2 text-left">source</th>
              <th className="px-3 py-2 text-left">event</th>
              <th className="px-3 py-2 text-left">external id</th>
              <th className="px-3 py-2 text-left">source event id</th>
              <th className="px-3 py-2 text-center">processed</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-900 dark:bg-zinc-950">
            {rows.map((w) => (
              <tr key={w.id}>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {new Date(w.receivedAt).toISOString().replace('T', ' ').slice(0, 19)}
                </td>
                <td className="px-3 py-2 font-mono text-xs">{w.source}</td>
                <td className="px-3 py-2 font-mono text-xs">{w.eventType}</td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">{w.externalId ?? '—'}</td>
                <td className="px-3 py-2 max-w-xs truncate font-mono text-xs text-zinc-500">
                  {w.sourceEventId}
                </td>
                <td className="px-3 py-2 text-center">
                  {w.processed ? (
                    <span className="text-emerald-600">✓</span>
                  ) : (
                    <span className="text-zinc-400">·</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-sm text-zinc-500">
                  No matching webhook events yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
