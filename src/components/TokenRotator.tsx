'use client';

import { generateBearerToken } from '@/server-actions/settings';
import { useState, useTransition } from 'react';

export function TokenRotator() {
  const [token, setToken] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);

  function rotate() {
    startTransition(async () => {
      const next = await generateBearerToken();
      setToken(next);
      setCopied(false);
    });
  }

  async function copy() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={rotate}
        disabled={pending}
        className="rounded-md bg-sky-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-sky-700 disabled:opacity-50"
      >
        {pending ? 'Generating…' : 'Generate new token'}
      </button>
      {token && (
        <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950/40">
          <p className="text-xs text-amber-800 dark:text-amber-200">
            New token below. Paste into <code>.env</code> as <code>LOCAL_BEARER_TOKEN=…</code>, then
            restart the dev/web server. The current token stays valid until then.
          </p>
          <pre className="overflow-x-auto rounded bg-white p-2 text-xs font-mono dark:bg-zinc-950">
            {token}
          </pre>
          <button
            type="button"
            onClick={copy}
            className="rounded bg-zinc-200 px-2 py-1 text-xs hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
    </div>
  );
}
