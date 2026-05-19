import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { asc } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default async function BrandsPage() {
  const rows = await db.select().from(brands).orderBy(asc(brands.slug));
  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Brands</h1>
          <p className="mt-1 text-sm text-zinc-500">{rows.length} total</p>
        </div>
        <Link
          href="/brands/new"
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
        >
          + New brand
        </Link>
      </header>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No brands yet.
        </p>
      ) : (
        <ul className="space-y-2">
          {rows.map((b) => (
            <li key={b.id}>
              <Link
                href={`/brands/${b.id}`}
                className="flex items-center justify-between rounded-lg border border-zinc-200 bg-white p-4 hover:border-zinc-300 hover:shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:hover:border-zinc-700"
              >
                <div>
                  <div className="font-medium">{b.name}</div>
                  <div className="mt-0.5 text-xs text-zinc-500">
                    {b.slug} · default {b.defaultProcessingProfile}
                  </div>
                </div>
                <span
                  className={`text-xs font-medium ${
                    b.active ? 'text-emerald-600' : 'text-zinc-400'
                  }`}
                >
                  {b.active ? 'active' : 'inactive'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
