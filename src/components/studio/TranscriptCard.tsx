'use client';

import { useState } from 'react';
import { SectionCard } from './SectionCard';
import { CopyButton } from './buttons';

export function TranscriptCard({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) {
    return (
      <SectionCard title="Transcript" icon="🧵">
        <p className="text-sm text-zinc-500">Not transcribed yet.</p>
      </SectionCard>
    );
  }
  const long = text.length > 1200;
  const shown = expanded || !long ? text : `${text.slice(0, 1200)}…`;
  return (
    <SectionCard
      title="Transcript"
      icon="🧵"
      ready
      actions={<CopyButton text={text} label="Copy transcript" />}
    >
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">
        {shown}
      </p>
      {long && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-3 text-sm text-sky-600 hover:underline"
        >
          {expanded ? 'Show less' : 'Show full transcript'}
        </button>
      )}
    </SectionCard>
  );
}
