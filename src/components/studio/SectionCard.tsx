import type { ReactNode } from 'react';

/**
 * Shared chrome for the studio's content sections (Titles, Description,
 * Tags, Transcript). Header shows the section title, a green ✓ when the
 * section has content, and a slot for action buttons.
 */
export function SectionCard({
  title,
  icon,
  ready,
  actions,
  children,
}: {
  title: string;
  icon?: string;
  ready?: boolean;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-xl border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
      <header className="mb-4 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          {icon && <span aria-hidden>{icon}</span>}
          {title}
          {ready && <span className="text-emerald-500">✓</span>}
        </h2>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </header>
      {children}
    </section>
  );
}
