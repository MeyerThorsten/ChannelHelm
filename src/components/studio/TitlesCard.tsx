'use client';

import type { ScoredItem } from '@/lib/asset-payload';
import { regenerateAsset } from '@/server-actions/regenerate';
import { saveAssetPayload } from '@/server-actions/regenerate';
import { selectTitle } from '@/server-actions/studio';
import { useState, useTransition } from 'react';
import { SectionCard } from './SectionCard';
import { AsyncActionButton, CopyButton } from './buttons';

const YT_LIMIT = 70;

export function TitlesCard({
  assetId,
  titles: initial,
  selectedIndex: initialSel,
}: {
  assetId: string | null;
  titles: ScoredItem[];
  selectedIndex: number;
}) {
  const [titles, setTitles] = useState(initial);
  const [sel, setSel] = useState(Math.min(initialSel, Math.max(initial.length - 1, 0)));
  const [editing, setEditing] = useState<number | null>(null);
  const [, startTransition] = useTransition();

  if (!assetId || titles.length === 0) {
    return (
      <SectionCard title="Titles" icon="📝">
        <p className="text-sm text-zinc-500">Not generated yet.</p>
      </SectionCard>
    );
  }

  function persist(next: ScoredItem[]) {
    setTitles(next);
    if (assetId) {
      const payload = { titles: next, selectedIndex: sel };
      startTransition(() => saveAssetPayload(assetId, payload));
    }
  }

  function choose(i: number) {
    setSel(i);
    if (assetId) startTransition(() => selectTitle(assetId, i));
  }

  return (
    <SectionCard
      title="Titles"
      icon="📝"
      ready
      actions={
        <>
          <CopyButton text={titles[sel]?.text ?? ''} label="Copy selected title" />
          <AsyncActionButton
            action={() => regenerateAsset(assetId)}
            icon="↻"
            pendingLabel="Regenerating…"
          >
            Regenerate
          </AsyncActionButton>
        </>
      }
    >
      <ul className="space-y-2">
        {titles.map((t, i) => {
          const over = t.text.length > YT_LIMIT;
          const isSel = i === sel;
          return (
            <li
              key={`${i}-${t.text.slice(0, 12)}`}
              className={`rounded-lg border px-4 py-3 transition ${
                isSel
                  ? 'border-orange-300 bg-orange-50 dark:border-orange-500/40 dark:bg-orange-950/30'
                  : 'border-zinc-200 hover:border-zinc-300 dark:border-zinc-800 dark:hover:border-zinc-700'
              }`}
            >
              {editing === i ? (
                <div className="flex items-center gap-2">
                  <input
                    // biome-ignore lint/a11y/noAutofocus: inline edit field focuses on open by intent
                    autoFocus
                    defaultValue={t.text}
                    className="flex-1 rounded border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-950"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        const next = [...titles];
                        next[i] = { ...t, text: (e.target as HTMLInputElement).value };
                        persist(next);
                        setEditing(null);
                      }
                      if (e.key === 'Escape') setEditing(null);
                    }}
                  />
                  <button
                    type="button"
                    className="text-xs text-sky-600"
                    onClick={(e) => {
                      const input = (e.currentTarget.previousSibling as HTMLInputElement) ?? null;
                      const value = input?.value ?? t.text;
                      const next = [...titles];
                      next[i] = { ...t, text: value };
                      persist(next);
                      setEditing(null);
                    }}
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => choose(i)}
                    className="flex-1 text-left text-sm"
                  >
                    {t.text}
                  </button>
                  <div className="flex items-center gap-3">
                    <span className={`text-xs ${over ? 'text-rose-500' : 'text-zinc-400'}`}>
                      {t.text.length}/{YT_LIMIT}
                    </span>
                    <button
                      type="button"
                      aria-label="Edit title"
                      className="text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
                      onClick={() => setEditing(i)}
                    >
                      ✏️
                    </button>
                    {t.score != null && (
                      <span className="rounded-full bg-orange-100 px-2 py-0.5 text-xs font-medium text-orange-700 dark:bg-orange-950/50 dark:text-orange-300">
                        {t.score}/100
                      </span>
                    )}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </SectionCard>
  );
}
