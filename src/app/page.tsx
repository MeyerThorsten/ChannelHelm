import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { desc, eq } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const rows = await db
    .select({
      pkg: packages,
      source: sources,
      brand: brands,
    })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .innerJoin(brands, eq(brands.id, packages.brandId))
    .orderBy(desc(packages.updatedAt))
    .limit(50);

  return (
    <main style={pageStyle}>
      <header style={{ marginBottom: '1.5rem' }}>
        <h1 style={{ margin: 0, fontSize: 24 }}>ChannelHelm</h1>
        <p style={{ margin: '0.25rem 0 0', color: '#888', fontSize: 13 }}>
          {rows.length} package{rows.length === 1 ? '' : 's'} · sorted by last update
        </p>
      </header>
      {rows.length === 0 ? (
        <p style={{ color: '#888' }}>
          No packages yet. POST to <code>/api/sources</code> and <code>/api/packages</code>.
        </p>
      ) : (
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {rows.map(({ pkg, source, brand }) => (
            <li key={pkg.id} style={cardStyle}>
              <Link
                href={`/packages/${pkg.id}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '1rem' }}>
                  <div>
                    <div style={{ fontWeight: 600 }}>
                      {source.title ?? source.originUrl ?? source.id}
                    </div>
                    <div style={{ color: '#777', fontSize: 12, marginTop: 4 }}>
                      {brand.slug} · {pkg.processingProfile} · {source.kind}
                    </div>
                  </div>
                  <div style={statusStyle(pkg.status)}>{pkg.status}</div>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

const pageStyle: React.CSSProperties = {
  fontFamily: 'system-ui, sans-serif',
  padding: '2rem',
  maxWidth: 880,
  margin: '0 auto',
};

const cardStyle: React.CSSProperties = {
  border: '1px solid #ddd',
  borderRadius: 8,
  padding: '0.85rem 1rem',
  marginBottom: 8,
  background: 'white',
};

function statusStyle(status: string): React.CSSProperties {
  const colors: Record<string, string> = {
    draft: '#888',
    analyzing: '#0a7',
    analyzed: '#0a7',
    ready_for_review: '#b60',
    approved: '#069',
    dispatching: '#069',
    published: '#0a4',
    failed: '#c33',
  };
  return {
    fontSize: 12,
    color: colors[status] ?? '#444',
    background: '#f4f4f4',
    padding: '0.25rem 0.5rem',
    borderRadius: 4,
    whiteSpace: 'nowrap',
    alignSelf: 'start',
  };
}
