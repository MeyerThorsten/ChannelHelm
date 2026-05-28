import { VoiceBootstrap } from '@/components/brands/VoiceBootstrap';
import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { getVoiceExampleCounts } from '@/server-actions/voice-bootstrap';
import { eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ id: string }>;
};

export default async function BrandVoicePage({ params }: Props) {
  const { id } = await params;

  const [brand] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  if (!brand) notFound();

  const counts = await getVoiceExampleCounts(id);

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '32px 32px 80px' }}>
      <Link
        href={`/brands/${id}`}
        style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none' }}
      >
        ← {brand.name}
      </Link>

      <header
        style={{
          marginTop: 12,
          marginBottom: 28,
          paddingBottom: 16,
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
        }}
      >
        <div>
          <h1
            className="serif"
            style={{ fontSize: 26, fontWeight: 400, margin: 0, letterSpacing: -0.3 }}
          >
            Brand voice bootstrap
          </h1>
          <p
            style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {brand.id} · {brand.name}
          </p>
        </div>
      </header>

      <div
        style={{
          marginBottom: 24,
          padding: '12px 14px',
          fontSize: 12,
          color: 'var(--text-muted)',
          background: 'color-mix(in oklab, var(--accent) 8%, transparent)',
          border: '1px solid color-mix(in oklab, var(--accent) 20%, transparent)',
          borderRadius: 8,
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: 'var(--text)', fontWeight: 600 }}>Cold-start tip:</strong> The A/B
        signal loop produces voice examples after publishing, but early videos generate assets
        without any few-shot context. Seed examples here to give the LLM a head-start.{' '}
        <span style={{ color: 'var(--text-faint)' }}>
          Seeded examples score 0.7; proven A/B winners score 0.9 — so real performance always wins
          once the loop warms up.
        </span>
      </div>

      <VoiceBootstrap brandId={id} initialCounts={counts} />
    </main>
  );
}
