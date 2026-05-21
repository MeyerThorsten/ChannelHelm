'use client';

import { useState, useTransition } from 'react';

/**
 * Empty-state generator for a studio section. Shows a "Generate" button that
 * runs the section's server action (which builds the analysis from the
 * transcript on demand if needed). Surfaces pending + error states.
 */
export function GenerateSection({
  label,
  action,
}: {
  label: string;
  action: () => Promise<void>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-start gap-2">
      <p className="text-sm text-zinc-500">Not generated yet.</p>
      <button
        type="button"
        disabled={pending}
        onClick={() => {
          setError(null);
          startTransition(async () => {
            try {
              await action();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
            }
          });
        }}
        className="inline-flex items-center gap-1.5 rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
      >
        ✦ {pending ? `Generating ${label}…` : `Generate ${label}`}
      </button>
      {error && <span className="text-xs text-rose-600">{error}</span>}
    </div>
  );
}
