import { Avatar, Eyebrow } from '@/components/ui';
import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { brandColor } from '@/lib/brand-color';
import { asc } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function BrandsPage() {
  const rows = await db.select().from(brands).orderBy(asc(brands.slug));
  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 32px 80px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          marginBottom: 20,
        }}
      >
        <div>
          <Eyebrow>Workspace</Eyebrow>
          <h1
            className="serif"
            style={{ fontSize: 32, fontWeight: 400, margin: '4px 0 2px', letterSpacing: -0.3 }}
          >
            Brands
          </h1>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: 0 }}>{rows.length} total</p>
        </div>
        <Link
          href="/brands/new"
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            padding: '7px 12px',
            fontSize: 12,
            fontWeight: 600,
            color: '#fff',
            background: 'var(--accent)',
            border: '1px solid color-mix(in oklab, var(--accent) 80%, white)',
            borderRadius: 6,
            textDecoration: 'none',
            boxShadow: '0 0 0 1px var(--accent-glow)',
          }}
        >
          + New brand
        </Link>
      </div>

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
          No brands yet.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {rows.map((b) => (
            <Link
              key={b.id}
              href={`/brands/${b.id}`}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                padding: 14,
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                textDecoration: 'none',
                color: 'inherit',
              }}
            >
              <Avatar
                glyph={b.slug.slice(0, 2).toUpperCase()}
                color={brandColor(b.slug)}
                size={32}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600 }}>{b.name}</div>
                <div
                  style={{
                    marginTop: 2,
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {b.slug} · {b.defaultProcessingProfile}
                  {b.website ? ` · ${b.website.replace(/^https?:\/\//, '')}` : ''}
                </div>
              </div>
              <span
                style={{
                  fontSize: 11,
                  fontWeight: 500,
                  color: b.active ? 'var(--status-published)' : 'var(--text-faint)',
                }}
              >
                {b.active ? 'active' : 'inactive'}
              </span>
            </Link>
          ))}
        </div>
      )}
    </main>
  );
}
