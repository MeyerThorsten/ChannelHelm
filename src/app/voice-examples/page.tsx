import { db } from '@/db/client';
import { brands, voiceExamples } from '@/db/schema';
import { asc, desc, eq, sql } from 'drizzle-orm';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ brand?: string; type?: string }>;

export default async function VoiceExamplesPage({
  searchParams,
}: {
  searchParams: SearchParams;
}) {
  const params = await searchParams;
  const brandRows = await db.select().from(brands).orderBy(asc(brands.slug));
  const selectedBrand =
    params.brand && brandRows.find((b) => b.id === params.brand) ? params.brand : null;

  const typeRows = await db
    .select({ assetType: voiceExamples.assetType, n: sql<number>`count(*)::int` })
    .from(voiceExamples)
    .where(selectedBrand ? eq(voiceExamples.brandId, selectedBrand) : undefined)
    .groupBy(voiceExamples.assetType)
    .orderBy(desc(sql`count(*)`));

  const examples = await db
    .select({
      ex: voiceExamples,
      brandName: brands.name,
      brandSlug: brands.slug,
    })
    .from(voiceExamples)
    .innerJoin(brands, eq(brands.id, voiceExamples.brandId))
    .where(
      [
        selectedBrand ? eq(voiceExamples.brandId, selectedBrand) : undefined,
        params.type ? eq(voiceExamples.assetType, params.type) : undefined,
      ].reduce<ReturnType<typeof eq> | undefined>((acc, f) => {
        if (!f) return acc;
        return acc ? sql`${acc} AND ${f}` : f;
      }, undefined),
    )
    .orderBy(desc(voiceExamples.performanceScore))
    .limit(100);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">Voice examples</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Top-performing assets promoted by <code>promote_voice_examples</code> — used as few-shot
          examples by <code>generate_asset</code>.
        </p>
      </header>

      <form className="mb-6 flex flex-wrap items-end gap-3 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <label className="text-sm">
          <span className="block text-zinc-700 dark:text-zinc-300">brand</span>
          <select
            name="brand"
            defaultValue={selectedBrand ?? ''}
            className="mt-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all</option>
            {brandRows.map((b) => (
              <option key={b.id} value={b.id}>
                {b.slug}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="block text-zinc-700 dark:text-zinc-300">asset type</span>
          <select
            name="type"
            defaultValue={params.type ?? ''}
            className="mt-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="">all</option>
            {typeRows.map((t) => (
              <option key={t.assetType} value={t.assetType}>
                {t.assetType} ({t.n})
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
        >
          Filter
        </button>
        <Link href="/voice-examples" className="text-sm text-zinc-500 hover:underline">
          reset
        </Link>
      </form>

      {examples.length === 0 ? (
        <p className="rounded-lg border border-dashed border-zinc-300 p-8 text-center text-sm text-zinc-500 dark:border-zinc-700">
          No voice examples yet. Run <code>scripts/enqueue-recurring.ts</code> after some assets
          have signals, or wait for the launchd job to fire.
        </p>
      ) : (
        <ul className="space-y-2">
          {examples.map(({ ex, brandSlug }) => (
            <li
              key={ex.id}
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="mb-2 flex items-center justify-between gap-2 text-xs text-zinc-500">
                <div className="font-mono">
                  {brandSlug} · {ex.assetType}
                </div>
                <div className="font-mono">
                  score {ex.performanceScore != null ? ex.performanceScore.toFixed(2) : '—'} · used{' '}
                  {ex.usedAsExampleCount}×
                </div>
              </div>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{ex.text}</p>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
