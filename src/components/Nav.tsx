import Link from 'next/link';

const LINKS = [
  { href: '/', label: 'New / Packages' },
  { href: '/brands', label: 'Brands' },
  { href: '/jobs', label: 'Jobs' },
  { href: '/webhooks', label: 'Webhooks' },
  { href: '/voice-examples', label: 'Voice' },
  { href: '/providers', label: 'Providers' },
  { href: '/settings', label: 'Settings' },
];

export function Nav() {
  return (
    <nav className="border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mx-auto flex max-w-6xl items-center gap-1 px-6 py-3">
        <Link href="/" className="mr-4 text-sm font-semibold tracking-tight">
          ChannelHelm
        </Link>
        <ul className="flex flex-wrap items-center gap-1 text-sm">
          {LINKS.map((l) => (
            <li key={l.href}>
              <Link
                href={l.href}
                className="rounded px-3 py-1.5 text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-900 dark:hover:text-zinc-100"
              >
                {l.label}
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </nav>
  );
}
