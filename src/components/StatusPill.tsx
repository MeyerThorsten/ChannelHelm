import type { ReactNode } from 'react';

const COLOR_BY_STATUS: Record<string, string> = {
  draft: 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300',
  analyzing: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  analyzed: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  ready_for_review: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200',
  approved: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  dispatching: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  scheduled: 'bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-200',
  published: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  failed: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200',
  rejected: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
};

export function StatusPill({ status, children }: { status: string; children?: ReactNode }) {
  const klass =
    COLOR_BY_STATUS[status] ?? 'bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300';
  return (
    <span className={`inline-flex items-center rounded px-2 py-0.5 text-xs font-medium ${klass}`}>
      {children ?? status}
    </span>
  );
}
