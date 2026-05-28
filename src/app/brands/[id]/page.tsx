import { BrandForm } from '@/components/BrandForm';
import { YoutubeConnectionCard } from '@/components/brands/YoutubeConnectionCard';
import { AsyncActionButton } from '@/components/studio/buttons';
import { db } from '@/db/client';
import { brands, packages } from '@/db/schema';
import { hydrateRuntimeSettingsForRoute } from '@/lib/settings';
import { slugify } from '@/lib/url';
import { renormalizeBrandSlug, updateBrandFromForm } from '@/server-actions/brands';
import { youtubeConnectionStatus } from '@workers/integrations/youtube';
import { count, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ yt_oauth?: string; channel?: string; msg?: string }>;
};

export default async function BrandDetailPage({ params, searchParams }: Props) {
  await hydrateRuntimeSettingsForRoute('brand-detail');

  const { id } = await params;
  const sp = await searchParams;
  const [brand] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  if (!brand) notFound();
  const [stats] = await db
    .select({ packageCount: count() })
    .from(packages)
    .where(eq(packages.brandId, id));

  const action = updateBrandFromForm.bind(null, id);
  const renorm = renormalizeBrandSlug.bind(null, id);
  const slugIsOff = slugify(brand.slug) !== brand.slug;

  // YouTube connection state for the new card. Tokens never leave the server.
  const ytStatus = await youtubeConnectionStatus(id);
  const oauthClientConfigured =
    !!process.env.GOOGLE_OAUTH_CLIENT_ID && !!process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const ytTarget = (brand.youtubeDispatchTarget ?? 'manual') as
    | 'manual'
    | 'youtube_direct'
    | 'zernio';
  const ytFlash =
    sp.yt_oauth === 'connected'
      ? { kind: 'connected' as const, channel: sp.channel }
      : sp.yt_oauth === 'cancelled'
        ? { kind: 'cancelled' as const }
        : sp.yt_oauth === 'error'
          ? { kind: 'error' as const, msg: sp.msg }
          : null;

  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '32px 32px 80px' }}>
      <Link
        href="/brands"
        style={{ fontSize: 12, color: 'var(--text-muted)', textDecoration: 'none' }}
      >
        ← brands
      </Link>
      <header
        style={{
          marginTop: 12,
          marginBottom: 24,
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
            style={{ fontSize: 30, fontWeight: 400, margin: 0, letterSpacing: -0.3 }}
          >
            {brand.name}
          </h1>
          <p
            style={{
              marginTop: 6,
              fontSize: 11,
              color: 'var(--text-faint)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {brand.id} · slug {brand.slug}
          </p>
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          {stats?.packageCount ?? 0} packages
        </span>
      </header>

      {slugIsOff && (
        <div
          style={{
            marginBottom: 24,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            borderRadius: 10,
            border: '1px solid color-mix(in oklab, var(--status-ready) 36%, transparent)',
            background: 'color-mix(in oklab, var(--status-ready) 10%, transparent)',
            padding: '12px 14px',
            fontSize: 12,
          }}
        >
          <span style={{ color: 'var(--text-muted)' }}>
            Slug <code>{brand.slug}</code> isn't normalized — it should be{' '}
            <code>{slugify(brand.slug)}</code>. Renaming moves the media folder + rewrites paths
            (blocked while jobs are running).
          </span>
          <AsyncActionButton action={renorm} pendingLabel="Renaming…" icon="↻">
            Normalize slug
          </AsyncActionButton>
        </div>
      )}

      <YoutubeConnectionCard
        brandId={id}
        oauthClientConfigured={oauthClientConfigured}
        initialStatus={{
          connected: ytStatus.connected,
          channelTitle: ytStatus.channelTitle,
          channelId: ytStatus.channelId,
          connectedAt: ytStatus.connectedAt,
        }}
        initialTarget={ytTarget}
        flash={ytFlash}
      />

      <BrandForm brand={brand} action={action} submitLabel="Save changes" />
    </main>
  );
}
