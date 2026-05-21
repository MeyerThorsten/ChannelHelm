import { Eyebrow, StatusPill } from '@/components/ui';
import { db } from '@/db/client';
import { jobs } from '@/db/schema';
import { and, desc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ kind?: string; status?: string }>;

const STAT_CARDS: { k: string; label: string; color: string }[] = [
  { k: 'running', label: 'Running', color: 'var(--status-analyzing)' },
  { k: 'pending', label: 'Pending', color: 'var(--text-faint)' },
  { k: 'done', label: 'Done', color: 'var(--status-published)' },
  { k: 'failed', label: 'Failed', color: 'var(--status-failed)' },
  { k: 'all', label: 'All', color: 'var(--text)' },
];

export default async function JobsPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const filters = [];
  if (params.kind) filters.push(eq(jobs.kind, params.kind));
  if (params.status) filters.push(eq(jobs.status, params.status));
  const where = filters.length === 0 ? undefined : and(...filters);

  const rows = await db.select().from(jobs).where(where).orderBy(desc(jobs.id)).limit(100);
  const statusRows = await db
    .select({ status: jobs.status, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.status);
  const byStatus = new Map(statusRows.map((s) => [s.status, s.n]));
  const total = statusRows.reduce((a, s) => a + s.n, 0);
  const count = (k: string) => (k === 'all' ? total : (byStatus.get(k) ?? 0));

  const kindRows = await db
    .select({ kind: jobs.kind, n: sql<number>`count(*)::int` })
    .from(jobs)
    .groupBy(jobs.kind)
    .orderBy(desc(sql`count(*)`));

  const cols = '92px 1.2fr 80px 1fr 1.4fr 150px';

  return (
    <main style={{ maxWidth: 1200, margin: '0 auto', padding: '32px 32px 80px' }}>
      <Eyebrow>Pipeline inspector</Eyebrow>
      <h1
        className="serif"
        style={{ fontSize: 32, fontWeight: 400, margin: '4px 0 6px', letterSpacing: -0.3 }}
      >
        Jobs queue
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 24px' }}>
        Background workers running locally · {count('running')} active · {count('pending')} queued
      </p>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 10,
          marginBottom: 20,
        }}
      >
        {STAT_CARDS.map((s) => {
          const active = (params.status ?? 'all') === s.k && (s.k !== 'all' || !params.status);
          const href = s.k === 'all' ? '/jobs' : `/jobs?status=${s.k}`;
          return (
            <Link
              key={s.k}
              href={href}
              style={{
                padding: 14,
                textAlign: 'left',
                background: active ? 'var(--bg-elev)' : 'var(--panel)',
                border: `1px solid ${active ? 'var(--border-strong)' : 'var(--border)'}`,
                borderRadius: 10,
                position: 'relative',
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              {active && (
                <span
                  style={{
                    position: 'absolute',
                    left: 0,
                    top: 0,
                    bottom: 0,
                    width: 2,
                    background: s.color,
                    borderRadius: '10px 0 0 10px',
                  }}
                />
              )}
              <div
                style={{
                  fontSize: 10,
                  color: 'var(--text-faint)',
                  textTransform: 'uppercase',
                  letterSpacing: 0.06,
                  marginBottom: 4,
                }}
              >
                {s.label}
              </div>
              <div
                style={{
                  fontSize: 22,
                  fontWeight: 500,
                  fontFamily: 'var(--font-mono)',
                  color: s.color,
                  letterSpacing: -0.5,
                }}
              >
                {count(s.k)}
              </div>
            </Link>
          );
        })}
      </div>

      {kindRows.length > 0 && (
        <form
          method="get"
          style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16 }}
        >
          {params.status && <input type="hidden" name="status" value={params.status} />}
          <span className="uppercase-eyebrow">Kind</span>
          <select
            name="kind"
            defaultValue={params.kind ?? ''}
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 8px',
              fontSize: 12,
              color: 'var(--text)',
            }}
          >
            <option value="">all kinds</option>
            {kindRows.map((k) => (
              <option key={k.kind} value={k.kind}>
                {k.kind} ({k.n})
              </option>
            ))}
          </select>
          <button
            type="submit"
            style={{
              background: 'var(--bg-elev)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '4px 10px',
              fontSize: 12,
              color: 'var(--text)',
              cursor: 'pointer',
            }}
          >
            Apply
          </button>
        </form>
      )}

      <div
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: cols,
            padding: '8px 14px',
            borderBottom: '1px solid var(--border)',
            fontSize: 10,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: 0.08,
            fontWeight: 500,
            background: 'var(--panel-strong)',
          }}
        >
          <span>Status</span>
          <span>Kind</span>
          <span style={{ textAlign: 'right' }}>Attempts</span>
          <span>Locked by</span>
          <span>Last error</span>
          <span>Run after</span>
        </div>
        {rows.map((j) => (
          <div
            key={j.id}
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              alignItems: 'center',
              padding: '10px 14px',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
            }}
          >
            <StatusPill status={j.status} size="sm" />
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{j.kind}</span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                textAlign: 'right',
                color: j.attempts > 1 ? 'var(--status-ready)' : 'var(--text-faint)',
              }}
            >
              {j.attempts}/{j.maxAttempts}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--text-faint)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {j.lockedBy ?? '—'}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--status-failed)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {j.lastError ?? ''}
            </span>
            <span
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-faint)' }}
            >
              {new Date(j.runAfter).toISOString().replace('T', ' ').slice(0, 19)}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div
            style={{ padding: 60, textAlign: 'center', color: 'var(--text-faint)', fontSize: 13 }}
          >
            No jobs match this filter
          </div>
        )}
      </div>
    </main>
  );
}
