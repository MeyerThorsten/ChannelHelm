'use client';

import { type ReactNode, useState, useTransition } from 'react';

const BASE =
  'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50';
const NEUTRAL =
  'border-zinc-300 bg-white text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800';

/** Copy text to the clipboard with transient "Copied" feedback. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={`${BASE} ${NEUTRAL}`}
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? '✓ Copied' : `⧉ ${label}`}
    </button>
  );
}

/**
 * Runs a server action with a pending state and surfaces any thrown error
 * inline. `children` is the resting label; `pendingLabel` shows while busy.
 */
export function AsyncActionButton({
  action,
  children,
  pendingLabel,
  variant = 'neutral',
  icon,
}: {
  action: () => Promise<void>;
  children: ReactNode;
  pendingLabel?: string;
  variant?: 'neutral' | 'primary' | 'danger';
  icon?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const variantClass =
    variant === 'primary'
      ? 'border-transparent bg-sky-600 text-white hover:bg-sky-700'
      : variant === 'danger'
        ? 'border-transparent bg-rose-600 text-white hover:bg-rose-700'
        : NEUTRAL;

  return (
    <span className="inline-flex flex-col items-end">
      <button
        type="button"
        disabled={pending}
        className={`${BASE} ${variantClass}`}
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
      >
        {icon && <span aria-hidden>{icon}</span>}
        {pending ? (pendingLabel ?? 'Working…') : children}
      </button>
      {error && <span className="mt-1 max-w-xs text-right text-xs text-rose-600">{error}</span>}
    </span>
  );
}
