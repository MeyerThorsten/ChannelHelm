import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ kind?: string; status?: string }>;

const STATUSES = ['pending', 'running', 'done', 'failed'] as const;

const PILL_BY_STATUS: Record<string, string> = {
  pending: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  running: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  done: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
};

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters = [];
  if (params.kind) filters.push(eq(jobs.kind, params.kind));
  if (params.status) filters.push(eq(jobs.status, params.status));
  const where = filters.length === 0 ? undefined : and(...filters);

  const rows = await db.select().from(jobs).where(where).orderBy(desc(jobs.id)).limit(100);
  const kindRows = await db
    .select({ kind: jobs.kind, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.kind)
    .orderBy(desc(sql`count(*)`));

  return (
    <main className="mx-auto max-w-6xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Jobs</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Latest 100 of {rows.length} matching. Filter by kind/status via querystring.
        </p>
      </header>

      <form className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="text-sm">
          <span className="block text-zinc-700 dark:text-zinc-300">kind</span>
          <select
            name="kind"
            defaultValue={params.kind ?? ''}
            className="mt-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all</option>
            {kindRows.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind} ({k.n})
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-zinc-700 dark:text-zinc-300">status</span>
          <select
            name="status"
            defaultValue={params.status ?? ''}
            className="mt-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
        >
          Filter
        </button>
        <a href="/jobs" className="text-sm text-zinc-500 hover:underline">
          reset
        </a>
      </form>

      <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
        <table className="min-w-full divide-y divide-zinc-200 text-sm dark:divide-zinc-800">
          <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500 dark:bg-zinc-900">
            <tr>
              <th className="px-3 py-2 text-left">id</th>
              <th className="px-3 py-2 text-left">kind</th>
              <th className="px-3 py-2 text-left">status</th>
              <th className="px-3 py-2 text-right">attempts</th>
              <th className="px-3 py-2 text-left">locked by</th>
              <th className="px-3 py-2 text-left">last error</th>
              <th className="px-3 py-2 text-left">run after</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 bg-white dark:divide-zinc-900 dark:bg-zinc-950">
            {rows.map((j) => (
              <tr key={j.id}>
                <td className="px-3 py-2 font-mono text-xs">{j.id}</td>
                <td className="px-3 py-2 font-mono text-xs">{j.kind}</td>
                <td className="px-3 py-2">
                  <span
                    className={`rounded px-2 py-0.5 text-xs font-medium ${
                      PILL_BY_STATUS[j.status] ?? PILL_BY_STATUS.pending
                    }`}
                  >
                    {j.status}
                  </span>
                </td>
                <td className="px-3 py-2 text-right font-mono text-xs">
                  {j.attempts}/{j.maxAttempts}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">{j.lockedBy ?? '—'}</td>
                <td className="px-3 py-2 max-w-xs truncate text-xs text-rose-600 dark:text-rose-400">
                  {j.lastError ?? '—'}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-zinc-500">
                  {new Date(j.runAfter).toISOString().replace('T', ' ').slice(0, 19)}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-3 py-8 text-center text-sm text-zinc-500">
                  No matching jobs.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </main>
  );
}
