import { BrandForm } from '@/components/BrandForm';
import { db } from '@/db/client';
import { brands, packages } from '@/db/schema';
import { updateBrandFromForm } from '@/server-actions/brands';
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

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/brands" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← brands
      </Link>
      <header className="mt-3 mb-6 flex items-end justify-between border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <div>
          <h1 className="text-2xl font-semibold">{brand.name}</h1>
          <p className="mt-1 text-xs font-mono text-zinc-500">{brand.id}</p>
        </div>
        <span className="text-sm text-zinc-500">{stats?.packageCount ?? 0} packages</span>
      </header>
      <BrandForm brand={brand} action={action} submitLabel="Save changes" />
    </main>
  );
}
