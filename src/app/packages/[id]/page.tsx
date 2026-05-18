import { db } from '@/db/client';
import { assets, brands, packages, sources } from '@/db/schema';
import { approveAsset, approvePackage, rejectAsset } from '@/server-actions/approvals';
import { asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ id: string }> };

export default async function PackageDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [joined] = await db
    .select({ pkg: packages, source: sources, brand: brands })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .innerJoin(brands, eq(brands.id, packages.brandId))
    .where(eq(packages.id, id))
    .limit(1);

  if (!joined) notFound();
  const { pkg, source, brand } = joined;
  const allAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.packageId, id))
    .orderBy(asc(assets.type));

  const intelligence = pkg.intelligence as Record<string, unknown>;
  const sceneLog = intelligence.scene_log as
    | { windows?: { start: number; end: number; text: string }[] }
    | undefined;

  const approve = approvePackage.bind(null, pkg.id, 'operator');

  return (
    <main
      style={{
        fontFamily: 'system-ui, sans-serif',
        padding: '2rem',
        maxWidth: 920,
        margin: '0 auto',
      }}
    >
      <Link href="/" style={{ fontSize: 13, color: '#069' }}>
        ← all packages
      </Link>
      <h1 style={{ marginTop: 12 }}>{source.title ?? source.originUrl ?? pkg.id}</h1>
      <p style={{ color: '#666', fontSize: 13 }}>
        {brand.slug} · {pkg.processingProfile} · status: {pkg.status}
      </p>

      {pkg.status !== 'approved' && allAssets.length > 0 && (
        <form action={approve} style={{ margin: '1rem 0' }}>
          <button
            type="submit"
            style={{
              background: '#069',
              color: 'white',
              border: 0,
              padding: '0.6rem 1.2rem',
              borderRadius: 6,
              fontSize: 14,
              cursor: 'pointer',
            }}
          >
            Approve entire package ({allAssets.filter((a) => !a.type.endsWith('_plan')).length}{' '}
            assets)
          </button>
        </form>
      )}

      <section style={section}>
        <h2 style={h2}>Assets ({allAssets.length})</h2>
        {allAssets.length === 0 ? (
          <p style={{ color: '#888' }}>None yet — pipeline still running.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {allAssets.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </ul>
        )}
      </section>

      <section style={section}>
        <h2 style={h2}>Scene log ({sceneLog?.windows?.length ?? 0} windows)</h2>
        {!sceneLog?.windows ? (
          <p style={{ color: '#888' }}>Not yet generated.</p>
        ) : (
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {sceneLog.windows.map((w) => (
              <li
                key={`${w.start}-${w.end}`}
                style={{
                  borderLeft: '3px solid #ddd',
                  paddingLeft: '0.75rem',
                  marginBottom: '0.5rem',
                  fontSize: 13,
                }}
              >
                <span style={{ color: '#888' }}>
                  {fmtTime(w.start)}–{fmtTime(w.end)}
                </span>
                <div>{w.text || <em style={{ color: '#aaa' }}>(silent)</em>}</div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function AssetCard({ asset }: { asset: typeof assets.$inferSelect }) {
  const approve = approveAsset.bind(null, asset.id);
  const reject = rejectAsset.bind(null, asset.id);
  const payload = asset.payload as Record<string, unknown>;
  return (
    <li
      style={{
        border: '1px solid #ddd',
        borderRadius: 8,
        padding: '0.85rem 1rem',
        marginBottom: 8,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
        <strong>{asset.type}</strong>
        <span style={{ fontSize: 12, color: '#888' }}>{asset.status}</span>
      </div>
      <pre
        style={{
          background: '#fafafa',
          padding: '0.5rem',
          borderRadius: 4,
          fontSize: 12,
          whiteSpace: 'pre-wrap',
          maxHeight: 180,
          overflow: 'auto',
          margin: '0.5rem 0',
        }}
      >
        {JSON.stringify(payload, null, 2)}
      </pre>
      {asset.status === 'ready_for_review' && (
        <div style={{ display: 'flex', gap: 8 }}>
          <form action={approve}>
            <button type="submit" style={btn('#069')}>
              Approve
            </button>
          </form>
          <form action={reject}>
            <button type="submit" style={btn('#a33')}>
              Reject
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

const section: React.CSSProperties = { marginTop: '2rem' };
const h2: React.CSSProperties = { fontSize: 16, color: '#444', marginBottom: '0.5rem' };
const btn = (bg: string): React.CSSProperties => ({
  background: bg,
  color: 'white',
  border: 0,
  padding: '0.35rem 0.8rem',
  borderRadius: 4,
  fontSize: 12,
  cursor: 'pointer',
});

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
