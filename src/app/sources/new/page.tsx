import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { createSourceFromForm } from '@/server-actions/sources';
import { asc, eq } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

const PROFILES = ['fast_audio_only', 'standard_audio_visual', 'premium_multimodal'] as const;
const KINDS = ['youtube_url', 'uploaded_video', 'podcast', 'transcript_only'] as const;

const INPUT =
  'mt-1 block w-full rounded-md border border-zinc-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-zinc-700 dark:bg-zinc-950';
const LABEL = 'block text-sm font-medium text-zinc-700 dark:text-zinc-300';

export default async function NewSourcePage() {
  const brandRows = await db
    .select()
    .from(brands)
    .where(eq(brands.active, true))
    .orderBy(asc(brands.slug));

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <Link href="/" className="text-sm text-sky-700 hover:underline dark:text-sky-400">
        ← packages
      </Link>
      <h1 className="mt-3 mb-6 text-2xl font-semibold">New source</h1>

      {brandRows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-6 text-sm text-zinc-500 dark:border-zinc-700">
          You need at least one active brand first.{' '}
          <Link href="/brands/new" className="text-sky-700 hover:underline dark:text-sky-400">
            Create one →
          </Link>
        </p>
      ) : (
        <form action={createSourceFromForm} className="space-y-5">
          <div>
            <label className={LABEL} htmlFor="brandId">
              Brand
            </label>
            <select id="brandId" name="brandId" required className={INPUT}>
              {brandRows.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.slug} — {b.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="kind">
              Kind
            </label>
            <select id="kind" name="kind" required defaultValue="youtube_url" className={INPUT}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className={LABEL} htmlFor="originUrl">
              Origin URL
            </label>
            <input
              id="originUrl"
              name="originUrl"
              type="url"
              placeholder="https://www.youtube.com/watch?v=…"
              className={INPUT}
            />
          </div>

          <div>
            <label className={LABEL} htmlFor="title">
              Title (optional)
            </label>
            <input id="title" name="title" className={INPUT} />
          </div>

          <div className="rounded-md border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input type="checkbox" name="createPackage" defaultChecked />
              Also create a package and start ingest immediately
            </label>
            <div className="mt-3">
              <label className={LABEL} htmlFor="processingProfile">
                Processing profile
              </label>
              <select
                id="processingProfile"
                name="processingProfile"
                defaultValue="standard_audio_visual"
                className={INPUT}
              >
                {PROFILES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <button
            type="submit"
            className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white hover:bg-sky-700"
          >
            Create source
          </button>
        </form>
      )}
    </main>
  );
}
