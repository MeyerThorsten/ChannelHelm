'use client';

import { generateThumbnails } from '@/server-actions/studio';
import { useState, useTransition } from 'react';

export function ThumbnailStrip({
  packageId,
  sourceId,
  thumbnails,
}: {
  packageId: string;
  sourceId: string;
  thumbnails: { id: string; url: string | null; score: number | null }[];
}) {
  const [faces, setFaces] = useState('auto');
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      {thumbnails.length > 0 && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {thumbnails.map((t) => (
            <div
              key={t.id}
              className="relative overflow-hidden rounded-lg border border-zinc-200 dark:border-zinc-800"
            >
              {t.url ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.url}
                  alt="thumbnail concept"
                  className="aspect-video w-full object-cover"
                />
              ) : (
                <div className="flex aspect-video items-center justify-center text-xs text-zinc-400">
                  no preview
                </div>
              )}
              {t.score != null && (
                <span className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-xs text-white">
                  {t.score}
                </span>
              )}
            </div>
          ))}
        </div>
      )}
      <div className="flex flex-col items-center gap-2">
        <button
          type="button"
          disabled={pending}
          onClick={() => {
            setError(null);
            startTransition(async () => {
              try {
                await generateThumbnails(packageId, sourceId, faces);
              } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
              }
            });
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-orange-500 px-5 py-2.5 text-sm font-semibold text-white hover:bg-orange-600 disabled:opacity-50"
        >
          ✦ {pending ? 'Queued…' : 'Generate AI Thumbnails'}
        </button>
        <label className="flex items-center gap-2 text-xs text-zinc-500">
          Faces:
          <select
            value={faces}
            onChange={(e) => setFaces(e.target.value)}
            className="rounded border border-zinc-300 bg-white px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
          >
            <option value="auto">Auto</option>
            <option value="on">On</option>
            <option value="off">Off</option>
          </select>
        </label>
        {error && <span className="text-xs text-rose-600">{error}</span>}
        <p className="text-xs text-zinc-400">
          Enqueues the thumbnail_concepts worker — refresh in a moment to see results.
        </p>
      </div>
    </div>
  );
}
