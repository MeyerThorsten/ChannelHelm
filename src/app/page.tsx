import { UploadDashboard } from '@/components/studio/UploadDashboard';
import { Avatar, Eyebrow, MockThumb, Pipeline, StatusPill } from '@/components/ui';
import { db } from '@/db/client';
import { assets, brands, packages, sources } from '@/db/schema';
import { brandColor } from '@/lib/brand-color';
import { formatDuration, pipelineProgress } from '@/lib/pipeline';
import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const READY_STATUSES = ['ready_for_review', 'approved', 'dispatched', 'published'];

function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return h;
}

export default async function HomePage() {
  const brandRows = await db
    .select({ id: brands.id, slug: brands.slug, name: brands.name })
    .from(brands)
    .where(eq(brands.active, true))
    .orderBy(asc(brands.slug));

  const rows = await db
    .select({ pkg: packages, source: sources, brand: brands })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .innerJoin(brands, eq(brands.id, packages.brandId))
    .orderBy(desc(packages.updatedAt))
    .limit(12);

  const ids = rows.map((r) => r.pkg.id);
  const counts = ids.length
    ? await db
        .select({
          packageId: assets.packageId,
          total: sql<number>`count(*)::int`,
          ready: sql<number>`count(*) filter (where ${inArray(assets.status, READY_STATUSES)})::int`,
        })
        .from(assets)
        .where(inArray(assets.packageId, ids))
        .groupBy(assets.packageId)
    : [];
  const countMap = new Map(counts.map((c) => [c.packageId, c]));

  return (
    <main style={{ maxWidth: 1100, margin: '0 auto', padding: '40px 32px 80px' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 4 }}>
        <Eyebrow>Ingest</Eyebrow>
        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>
          local · {brandRows.length} brand{brandRows.length === 1 ? '' : 's'}
        </span>
      </div>
      <h1
        className="serif"
        style={{
          fontSize: 44,
          fontWeight: 400,
          margin: '4px 0 6px',
          letterSpacing: -0.5,
          lineHeight: 1.05,
        }}
      >
        Drop a video.
        <span style={{ color: 'var(--text-faint)', fontStyle: 'italic' }}>
          {' '}
          Get a publishing kit.
        </span>
      </h1>
      <p style={{ fontSize: 14, color: 'var(--text-muted)', margin: '0 0 28px', maxWidth: 580 }}>
        ChannelHelm transcribes, analyzes, and drafts every asset for every platform — locally on
        your Mac. Review, edit, approve, ship.
      </p>

      <UploadDashboard brands={brandRows} />

      <div style={{ marginTop: 36 }}>
        <Eyebrow style={{ marginBottom: 12 }}>Recent packages · {rows.length}</Eyebrow>
        {rows.length === 0 ? (
          <div
            style={{
              borderRadius: 10,
              border: '1px dashed var(--border)',
              padding: 32,
              textAlign: 'center',
              color: 'var(--text-faint)',
              fontSize: 13,
            }}
          >
            Nothing yet — ingest a video above.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {rows.map(({ pkg, source, brand }) => {
              const c = countMap.get(pkg.id);
              const progress = pipelineProgress(pkg.intelligence, pkg.status);
              const title = source.title ?? source.originUrl ?? pkg.id;
              return (
                <Link
                  key={pkg.id}
                  href={`/packages/${pkg.id}`}
                  style={{
                    display: 'flex',
                    gap: 12,
                    padding: 12,
                    background: 'var(--panel)',
                    border: '1px solid var(--border)',
                    borderRadius: 10,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <div
                    style={{
                      position: 'relative',
                      width: 88,
                      height: 56,
                      borderRadius: 6,
                      overflow: 'hidden',
                      flexShrink: 0,
                    }}
                  >
                    <MockThumb seed={seedOf(pkg.id)} style={{ position: 'absolute', inset: 0 }} />
                    <div
                      style={{
                        position: 'absolute',
                        right: 4,
                        bottom: 4,
                        padding: '1px 5px',
                        fontSize: 9,
                        background: 'rgba(0,0,0,0.72)',
                        color: '#fff',
                        borderRadius: 3,
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {formatDuration(source.durationSeconds)}
                    </div>
                  </div>
                  <div
                    style={{
                      flex: 1,
                      minWidth: 0,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
                      <Avatar
                        glyph={brand.slug.slice(0, 2).toUpperCase()}
                        color={brandColor(brand.slug)}
                        size={16}
                      />
                      <span
                        style={{
                          fontSize: 11,
                          color: 'var(--text-muted)',
                          fontWeight: 500,
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {brand.name}
                      </span>
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--text-faint)',
                          fontFamily: 'var(--font-mono)',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                        }}
                      >
                        · {pkg.processingProfile.replace(/_/g, ' ')}
                      </span>
                    </div>
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 500,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {title}
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 2 }}>
                      <StatusPill status={pkg.status} size="sm" />
                      <Pipeline progress={progress} compact />
                      <span style={{ flex: 1 }} />
                      <span
                        style={{
                          fontSize: 10,
                          color: 'var(--text-faint)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {c ? `${c.ready}/${c.total}` : '0/0'} assets
                      </span>
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </div>
    </main>
  );
}
