import { BrandForm } from '@/components/BrandForm';
import { AsyncActionButton } from '@/components/studio/buttons';
import { db } from '@/db/client';
import { brands, packages } from '@/db/schema';
import { slugify } from '@/lib/url';
import { renormalizeBrandSlug, updateBrandFromForm } from '@/server-actions/brands';
import { count, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type Props = { params: Promise<{ id: string }> };

export default async function BrandDetailPage({ params }: Props) {
  const { id } = await params;
  const [brand] = await db.select().from(brands).where(eq(brands.id, id)).limit(1);
  if (!brand) notFound();
  const [stats] = await db
    .select({ packageCount: count() })
    .from(packages)
    .where(eq(packages.brandId, id));

  const action = updateBrandFromForm.bind(null, id);
  const renorm = renormalizeBrandSlug.bind(null, id);
  const slugIsOff = slugify(brand.slug) !== brand.slug;

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/brands" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← brands
      </Link>
      <header className="mt-3 mb-6 flex items-end justify-between border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold">{brand.name}</h1>
          <p className="mt-1 font-mono text-xs text-zinc-500">
            {brand.id} · slug <code>{brand.slug}</code>
          </p>
        </div>
        <span className="text-sm text-zinc-500">{stats?.packageCount ?? 0} packages</span>
      </header>

      {slugIsOff && (
        <div className="mb-6 flex items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm dark:border-amber-900 dark:bg-amber-950/40">
          <span className="text-amber-800 dark:text-amber-200">
            Slug <code>{brand.slug}</code> isn't normalized — it should be{' '}
            <code>{slugify(brand.slug)}</code>. Renaming moves the media folder + rewrites paths
            (blocked while jobs are running).
          </span>
          <AsyncActionButton action={renorm} pendingLabel="Renaming…" icon="↻">
            Normalize slug
          </AsyncActionButton>
        </div>
      )}

      <BrandForm brand={brand} action={action} submitLabel="Save changes" />
    </main>
  );
}
