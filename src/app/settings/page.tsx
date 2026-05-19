import { TokenRotator } from '@/components/TokenRotator';

export const dynamic = 'force-dynamic';

function mask(v: string | undefined, keep = 4): string {
  if (!v) return '(unset)';
  if (v.length <= keep * 2) return '*'.repeat(v.length);
  return `${v.slice(0, keep)}…${v.slice(-keep)} (${v.length} chars)`;
}

const ENVS: { key: string; label: string; sensitive: boolean; help: string }[] = [
  {
    key: 'DATABASE_URL',
    label: 'DATABASE_URL',
    sensitive: true,
    help: 'Postgres connection string.',
  },
  {
    key: 'LOCAL_BEARER_TOKEN',
    label: 'LOCAL_BEARER_TOKEN',
    sensitive: true,
    help: 'API bearer token. Rotate via the button below.',
  },
  { key: 'MEDIA_ROOT', label: 'MEDIA_ROOT', sensitive: false, help: 'Where ingest writes media.' },
  {
    key: 'LM_STUDIO_DEFAULT_HOST',
    label: 'LM_STUDIO_DEFAULT_HOST',
    sensitive: false,
    help: 'OpenAI-compatible endpoint for Qwen3 32B.',
  },
  {
    key: 'LM_STUDIO_PREMIUM_HOST',
    label: 'LM_STUDIO_PREMIUM_HOST',
    sensitive: false,
    help: 'Endpoint for premium model (Qwen3 235B).',
  },
  {
    key: 'OPENCLAW_BASE_URL',
    label: 'OPENCLAW_BASE_URL',
    sensitive: false,
    help: 'Optional routing proxy.',
  },
  {
    key: 'ZERNIO_API_KEY',
    label: 'ZERNIO_API_KEY',
    sensitive: true,
    help: 'Required for dispatch → Zernio.',
  },
  {
    key: 'ZERNIO_WEBHOOK_SECRET',
    label: 'ZERNIO_WEBHOOK_SECRET',
    sensitive: true,
    help: 'When set, the receiver requires a matching x-zernio-signature header.',
  },
  {
    key: 'DOJOCLAW_API_URL',
    label: 'DOJOCLAW_API_URL',
    sensitive: false,
    help: 'LAN URL for DojoClaw.',
  },
  {
    key: 'DOJOCLAW_API_KEY',
    label: 'DOJOCLAW_API_KEY',
    sensitive: true,
    help: 'Required for dispatch → DojoClaw.',
  },
  {
    key: 'DOJOCLAW_WEBHOOK_SECRET',
    label: 'DOJOCLAW_WEBHOOK_SECRET',
    sensitive: true,
    help: 'Optional HMAC verification.',
  },
  {
    key: 'HF_TOKEN',
    label: 'HF_TOKEN',
    sensitive: true,
    help: 'Enables ml/diarize.py. Token must have pyannote model licenses accepted.',
  },
  {
    key: 'CLOUDFLARE_TUNNEL_HOSTNAME',
    label: 'CLOUDFLARE_TUNNEL_HOSTNAME',
    sensitive: false,
    help: 'Public base URL for inbound webhooks + /media/*.',
  },
];

export default function SettingsPage() {
  return (
    <main className="mx-auto max-w-3xl px-6 py-10">
      <header className="mb-8">
        <h1 className="text-2xl font-semibold">Settings</h1>
        <p className="mt-1 text-sm text-zinc-500">
          Read-only view of the running process's environment. To change values, edit{' '}
          <code>.env</code> and restart.
        </p>
      </header>

      <section className="mb-10 rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Rotate local bearer token
        </h2>
        <p className="mb-4 text-sm text-zinc-600 dark:text-zinc-400">
          Generates a new value; the page does NOT write <code>.env</code> for you (deliberate —
          would mid-flight invalidate every worker that holds the old token). Paste into{' '}
          <code>.env</code> as <code>LOCAL_BEARER_TOKEN=…</code> and restart.
        </p>
        <TokenRotator />
      </section>

      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Environment
        </h2>
        <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-900">
          {ENVS.map((e) => {
            const value = process.env[e.key];
            const display = e.sensitive ? mask(value) : (value ?? '(unset)');
            return (
              <li key={e.key} className="px-4 py-3 text-sm">
                <div className="flex items-baseline justify-between gap-3">
                  <code className="font-mono text-xs">{e.label}</code>
                  <code
                    className={`font-mono text-xs ${
                      value ? 'text-emerald-600 dark:text-emerald-400' : 'text-zinc-400'
                    }`}
                  >
                    {display}
                  </code>
                </div>
                <p className="mt-1 text-xs text-zinc-500">{e.help}</p>
              </li>
            );
          })}
        </ul>
      </section>
    </main>
  );
}
