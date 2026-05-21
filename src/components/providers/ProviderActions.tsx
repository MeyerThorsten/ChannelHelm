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

  const btn: React.CSSProperties = {
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--bg-elev)',
    padding: '4px 9px',
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text)',
    cursor: 'pointer',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          disabled={pending}
          style={btn}
          onClick={() => run(() => testProvider(id))}
        >
          {pending ? '…' : 'Test'}
        </button>
        <Link
          href={`/providers/${id}`}
          style={{ ...btn, textDecoration: 'none', display: 'inline-block' }}
        >
          Edit
        </Link>
        {!isDefault && (
          <button
            type="button"
            disabled={pending}
            style={btn}
            onClick={() => run(() => setDefaultProvider(id))}
          >
            Make default
          </button>
        )}
        <button
          type="button"
          disabled={pending}
          style={{ ...btn, color: 'var(--status-failed)' }}
          onClick={() => run(() => deleteProvider(id))}
        >
          Delete
        </button>
      </div>
      {result && <span style={{ fontSize: 11, color: 'var(--status-published)' }}>{result}</span>}
      {error && (
        <span
          style={{ maxWidth: 280, textAlign: 'right', fontSize: 11, color: 'var(--status-failed)' }}
        >
          {error}
        </span>
      )}
    </div>
  );
}
