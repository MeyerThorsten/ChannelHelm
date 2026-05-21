'use client';

import { deleteProvider, setDefaultProvider, testProvider } from '@/server-actions/providers';
import Link from 'next/link';
import { useState, useTransition } from 'react';

export function ProviderActions({ id, isDefault }: { id: number; isDefault: boolean }) {
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function run(fn: () => Promise<unknown>) {
    setResult(null);
    setError(null);
    startTransition(async () => {
      try {
        const r = await fn();
        if (typeof r === 'string') setResult(r);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    });
  }

  const btn =
    'rounded-md border border-zinc-300 px-2.5 py-1 text-xs font-medium hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800';

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={pending}
          className={btn}
          onClick={() => run(() => testProvider(id))}
        >
          {pending ? '…' : 'Test'}
        </button>
        <Link href={`/providers/${id}`} className={btn}>
          Edit
        </Link>
        {!isDefault && (
          <button
            type="button"
            disabled={pending}
            className={btn}
            onClick={() => run(() => setDefaultProvider(id))}
          >
            Make default
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          className={`${btn} text-rose-600`}
          onClick={() => run(() => deleteProvider(id))}
        >
          Delete
        </button>
      </div>
      {result && <span className="text-xs text-emerald-600">{result}</span>}
      {error && <span className="max-w-xs text-right text-xs text-rose-600">{error}</span>}
    </div>
  );
}
