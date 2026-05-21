'use client';

import type { ScoredItem } from '@/lib/asset-payload';
import { generateSection, regenerateAsset, saveAssetPayload } from '@/server-actions/regenerate';
import { useState, useTransition } from 'react';
import { GenerateSection } from './GenerateSection';
import { SectionCard } from './SectionCard';
import { AsyncActionButton, CopyButton } from './buttons';

export function TagsCard({
  packageId,
  assetId,
  tags: initial,
}: {
  packageId: string;
  assetId: string | null;
  tags: ScoredItem[];
}) {
  const [tags, setTags] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial.map((t) => t.text).join(', '));
  const [, startTransition] = useTransition();

  if (!assetId || tags.length === 0) {
    return (
      <SectionCard title="Tags" icon="🏷️">
        <GenerateSection label="tags" action={() => generateSection(packageId, 'youtube_tags')} />
      </SectionCard>
    );
  }

  function save() {
    const next: ScoredItem[] = draft
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((text) => {
        const prev = tags.find((t) => t.text === text);
        return { text, score: prev?.score ?? null };
      });
    setTags(next);
    setEditing(false);
    startTransition(() => saveAssetPayload(assetId as string, { tags: next }));
  }

  const copyText = tags.map((t) => t.text).join(', ');

  return (
    <SectionCard
      title="Tags"
      icon="🏷️"
      ready
      actions={
        <>
          {editing ? (
            <button
              type="button"
              onClick={save}
              className="rounded-md border border-transparent bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700"
            >
              Save
            </button>
          ) : (
            <button
              type="button"
              onClick={() => {
                setDraft(tags.map((t) => t.text).join(', '));
                setEditing(true);
              }}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              ✎ Edit
            </button>
          )}
          <CopyButton text={copyText} label="Copy tags" />
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
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          placeholder="comma, separated, tags"
          className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm dark:border-zinc-700 dark:bg-zinc-950"
        />
      ) : (
        <div className="flex flex-wrap gap-2">
          {tags.map((t, i) => (
            <span
              key={`${i}-${t.text}`}
              className="inline-flex items-center gap-1.5 rounded-md bg-zinc-100 px-2.5 py-1 text-sm dark:bg-zinc-800"
            >
              {t.text}
              {t.score != null && <span className="text-xs text-orange-500">{t.score}</span>}
            </span>
          ))}
        </div>
      )}
    </SectionCard>
  );
}
