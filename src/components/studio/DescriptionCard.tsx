'use client';

import { generateSection, regenerateAsset, saveAssetPayload } from '@/server-actions/regenerate';
import { useState, useTransition } from 'react';
import { GenerateSection } from './GenerateSection';
import { SectionCard } from './SectionCard';
import { AsyncActionButton, CopyButton } from './buttons';

export function DescriptionCard({
  packageId,
  assetId,
  text: initial,
}: {
  packageId: string;
  assetId: string | null;
  text: string;
}) {
  const [text, setText] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(initial);
  const [, startTransition] = useTransition();

  if (!assetId) {
    return (
      <SectionCard title="Description" icon="📄">
        <GenerateSection
          label="description"
          action={() => generateSection(packageId, 'youtube_description')}
        />
      </SectionCard>
    );
  }

  function save() {
    setText(draft);
    setEditing(false);
    startTransition(() => saveAssetPayload(assetId as string, { text: draft }));
  }

  return (
    <SectionCard
      title="Description"
      icon="📄"
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
                setDraft(text);
                setEditing(true);
              }}
              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
            >
              ✎ Edit
            </button>
          )}
          <CopyButton text={text} label="Copy description" />
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
          rows={16}
          className="w-full rounded-lg border border-zinc-300 bg-white p-3 text-sm leading-relaxed dark:border-zinc-700 dark:bg-zinc-950"
        />
      ) : (
        <pre className="whitespace-pre-wrap rounded-lg bg-zinc-50 p-4 text-sm leading-relaxed text-zinc-800 dark:bg-zinc-950 dark:text-zinc-200">
          {text || <span className="text-zinc-400">Empty.</span>}
        </pre>
      )}
    </SectionCard>
  );
}
