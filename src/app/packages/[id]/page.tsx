import { StatusPill } from '@/components/StatusPill';
import { db } from '@/db/client';
import { assets, brands, packages, sources } from '@/db/schema';
import { approveAsset, approvePackage, rejectAsset } from '@/server-actions/approvals';
import { asc, eq } from 'drizzle-orm';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';

type PageProps = { params: Promise<{ id: string }> };

export default async function PackageDetailPage({ params }: PageProps) {
  const { id } = await params;
  const [joined] = await db
    .select({ pkg: packages, source: sources, brand: brands })
    .from(packages)
    .innerJoin(sources, eq(sources.id, packages.sourceId))
    .innerJoin(brands, eq(brands.id, packages.brandId))
    .where(eq(packages.id, id))
    .limit(1);

  if (!joined) notFound();
  const { pkg, source, brand } = joined;
  const allAssets = await db
    .select()
    .from(assets)
    .where(eq(assets.packageId, id))
    .orderBy(asc(assets.type));

  const intelligence = pkg.intelligence as Record<string, unknown>;
  const sceneLog = intelligence.scene_log as
    | { windows?: { start: number; end: number; text: string }[] }
    | undefined;
  const approveAll = approvePackage.bind(null, pkg.id, 'operator');
  const dispatchable = allAssets.filter((a) => !a.type.endsWith('_plan'));

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <nav className="mb-4 text-sm">
        <Link href="/" className="text-sky-700 hover:underline dark:text-sky-400">
          ← all packages
        </Link>
      </nav>

      <header className="mb-8 border-b border-zinc-200 pb-4 dark:border-zinc-800">
        <h1 className="text-2xl font-semibold tracking-tight">
          {source.title ?? source.originUrl ?? pkg.id}
        </h1>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-sm text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{brand.slug}</span>
          <span>·</span>
          <span>{pkg.processingProfile}</span>
          <span>·</span>
          <StatusPill status={pkg.status} />
        </div>

        {pkg.status !== 'approved' && allAssets.length > 0 && (
          <form action={approveAll} className="mt-4">
            <button
              type="submit"
              className="rounded-md bg-sky-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-sky-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            >
              Approve entire package ({dispatchable.length} assets)
            </button>
          </form>
        )}
      </header>

      <section className="mb-10">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Assets ({allAssets.length})
        </h2>
        {allAssets.length === 0 ? (
          <p className="text-sm text-zinc-500">None yet — pipeline still running.</p>
        ) : (
          <ul className="space-y-2">
            {allAssets.map((a) => (
              <AssetCard key={a.id} asset={a} />
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Scene log ({sceneLog?.windows?.length ?? 0} windows)
        </h2>
        {!sceneLog?.windows ? (
          <p className="text-sm text-zinc-500">Not yet generated.</p>
        ) : (
          <ol className="space-y-2">
            {sceneLog.windows.map((w) => (
              <li
                key={`${w.start}-${w.end}`}
                className="rounded border-l-2 border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <div className="mb-1 text-xs font-mono text-zinc-500">
                  {fmtTime(w.start)}–{fmtTime(w.end)}
                </div>
                <div>{w.text || <em className="text-zinc-400">(silent)</em>}</div>
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}

function AssetCard({ asset }: { asset: typeof assets.$inferSelect }) {
  const approve = approveAsset.bind(null, asset.id);
  const reject = rejectAsset.bind(null, asset.id);
  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="mb-2 flex items-center justify-between gap-2">
        <strong className="font-mono text-sm">{asset.type}</strong>
        <StatusPill status={asset.status} />
      </div>
      <pre className="max-h-48 overflow-auto rounded bg-zinc-50 p-2 text-xs leading-relaxed text-zinc-700 dark:bg-zinc-950 dark:text-zinc-300">
        {JSON.stringify(asset.payload as Record<string, unknown>, null, 2)}
      </pre>
      {asset.status === 'ready_for_review' && (
        <div className="mt-3 flex gap-2">
          <form action={approve}>
            <button
              type="submit"
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white hover:bg-sky-700"
            >
              Approve
            </button>
          </form>
          <form action={reject}>
            <button
              type="submit"
              className="rounded bg-rose-600 px-3 py-1 text-xs font-medium text-white hover:bg-rose-700"
            >
              Reject
            </button>
          </form>
        </div>
      )}
    </li>
  );
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
