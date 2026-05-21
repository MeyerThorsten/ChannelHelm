import { StatusPill } from '@/components/StatusPill';
import { UploadDashboard } from '@/components/studio/UploadDashboard';
import { db } from '@/db/client';
import { brands, packages, sources } from '@/db/schema';
import { asc, desc, eq } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

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
    .limit(24);

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">New video</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Drop a file or paste a link to start the pipeline.
        </p>
      </header>

      <UploadDashboard brands={brandRows} />

      <section className="mt-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Recent packages ({rows.length})
        </h2>
        {rows.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
            Nothing yet — ingest a video above.
          </p>
        ) : (
          <ul className="space-y-2">
            {rows.map(({ pkg, source, brand }) => (
              <li key={pkg.id}>
                <Link
                  href={`/packages/${pkg.id}`}
                  className="group flex items-start justify-between gap-4 rounded-lg border border-zinc-200 bg-white p-4 transition hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
                >
                  <div className="min-w-0">
                    <div className="truncate text-sm font-medium group-hover:underline">
                      {source.title ?? source.originUrl ?? source.id}
                    </div>
                    <div className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      <span className="font-medium text-zinc-700 dark:text-zinc-300">
                        {brand.slug}
                      </span>{' '}
                      · {pkg.processingProfile} · {source.kind}
                    </div>
                  </div>
                  <StatusPill status={pkg.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
