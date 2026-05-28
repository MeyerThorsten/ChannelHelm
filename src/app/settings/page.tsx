import { TokenRotator } from '@/components/TokenRotator';
import { type SettingItem, SettingsEditor } from '@/components/settings/SettingsEditor';
import { Eyebrow } from '@/components/ui';
import { SETTINGS_CATALOGUE, ensureHydrated, maskValue, settingsTableExists } from '@/lib/settings';
import Link from 'next/link';

export const dynamic = 'force-dynamic';

/**
 * Editable settings. Mirrors DojoClaw's /settings — values persist in the
 * `settings` Postgres table, hydrate into `process.env` at boot, and update
 * across the Next.js + worker processes live via pg_notify('chs_settings').
 *
 * Boot-only keys (DATABASE_URL, MEDIA_ROOT, LOCAL_BEARER_TOKEN,
 * PROVIDER_SECRET_KEY) stay read-only — changing them mid-flight is unsafe.
 *
 * LLM provider configuration lives at /providers (the DojoClaw-style
 * llm_providers table). This page links there instead of duplicating it.
 */
export default async function SettingsPage() {
  // Health check + lazy hydration. Only one banner now — the red migration
  // one. Cross-process propagation runs through the worker LISTEN subscriber
  // started in workers/runner.ts; the Next.js process updates its own
  // process.env in-handler via setSetting().
  const migrationNeeded = !(await settingsTableExists());
  if (!migrationNeeded) {
    await ensureHydrated().catch(() => {});
  }

  // Build the catalogue on the server so secrets are masked before they
  // reach the client bundle.
  const items: SettingItem[] = SETTINGS_CATALOGUE.map((def) => {
    const env = process.env[def.key];
    const isSet = env != null && env !== '';
    return {
      key: def.key,
      value: def.sensitive ? maskValue(env) : (env ?? ''),
      isSet,
      sensitive: def.sensitive,
      kind: def.kind,
      help: def.help,
      bootOnly: !!def.bootOnly,
    } satisfies SettingItem;
  });

  const editable = items.filter((i) => !i.bootOnly);
  const bootOnly = items.filter((i) => i.bootOnly);

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 32px 80px' }}>
      <Eyebrow>Configuration</Eyebrow>
      <h1
        className="serif"
        style={{ fontSize: 32, fontWeight: 400, margin: '4px 0 6px', letterSpacing: -0.3 }}
      >
        Settings
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 24px', maxWidth: 680 }}>
        Editable values persist in the <code>settings</code> table and propagate live across the
        Next.js server and the worker fleet via Postgres <code>NOTIFY</code>. Boot-only values (DB
        connection, media root, bearer token, encryption key) still live in <code>.env</code> —
        changing them mid-flight is unsafe.
      </p>

      {/* ─── Infra banners ─────────────────────────────────────────────── */}
      {migrationNeeded && (
        <section
          style={{
            marginBottom: 18,
            padding: 14,
            background: 'color-mix(in oklab, var(--status-failed) 10%, var(--panel))',
            border: '1px solid color-mix(in oklab, var(--status-failed) 40%, var(--border))',
            borderRadius: 10,
          }}
        >
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--status-failed)',
              marginBottom: 4,
            }}
          >
            Settings table not migrated yet
          </div>
          <p style={{ margin: '0 0 10px', fontSize: 12.5, color: 'var(--text-muted)' }}>
            The <code>settings</code> table doesn&apos;t exist. Saves on this page will fail until
            you apply <code>migrations/0005_settings.sql</code>.
          </p>
          <pre
            style={{
              margin: 0,
              padding: 10,
              background: 'var(--bg-elev-2)',
              border: '1px solid var(--border)',
              borderRadius: 6,
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: 'var(--text)',
              overflowX: 'auto',
            }}
          >
            pnpm db:migrate
          </pre>
          <p style={{ margin: '8px 0 0', fontSize: 11.5, color: 'var(--text-faint)' }}>
            After the migration completes, Ctrl-C <code>pnpm dev:all</code> and restart it once so
            the boot hooks ( <code>loadSettingsIntoEnv</code> +{' '}
            <code>subscribeSettingsChanges</code>) fire on the Next.js server and the worker fleet.
          </p>
        </section>
      )}

      {/* LLM banner — point at /providers, the real LLM editor (DojoClaw pattern) */}
      <section
        style={{
          marginBottom: 28,
          padding: 16,
          background: 'color-mix(in oklab, var(--accent) 8%, var(--panel))',
          border: '1px solid color-mix(in oklab, var(--accent) 30%, var(--border))',
          borderRadius: 12,
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          justifyContent: 'space-between',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}>LLM providers</div>
          <p style={{ margin: 0, fontSize: 12.5, color: 'var(--text-muted)', maxWidth: 520 }}>
            OpenAI · Anthropic · OpenRouter · Ollama · LM Studio · OpenClaw · Codex CLI. Managed in
            the DojoClaw-style provider editor with per-purpose routing and at-rest key encryption.
          </p>
        </div>
        <Link
          href="/providers"
          style={{
            padding: '8px 14px',
            fontSize: 12,
            fontWeight: 600,
            borderRadius: 7,
            background: 'var(--accent)',
            color: '#fff',
            border: '1px solid color-mix(in oklab, var(--accent) 75%, white)',
            textDecoration: 'none',
            whiteSpace: 'nowrap',
          }}
        >
          Open /providers →
        </Link>
      </section>

      <section style={{ marginBottom: 32 }}>
        <Eyebrow style={{ marginBottom: 10 }}>Runtime settings</Eyebrow>
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-faint)',
            margin: '0 0 12px',
          }}
        >
          Saved values overwrite <code>.env</code> at runtime. Secrets are stored encrypted
          (AES-256-GCM) and never sent back to the browser — the mask placeholder means &quot;keep
          saved&quot;.
        </p>
        <SettingsEditor items={editable} subscriberLive={true} />
      </section>

      <section style={{ marginBottom: 32 }}>
        <Eyebrow style={{ marginBottom: 10 }}>Boot-only</Eyebrow>
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-faint)',
            margin: '0 0 12px',
          }}
        >
          These can&apos;t be changed mid-flight without breaking running workers. Edit{' '}
          <code>.env</code> and restart the dev/web server.
        </p>
        <SettingsEditor items={bootOnly} />
      </section>

      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
        }}
      >
        <Eyebrow style={{ marginBottom: 8 }}>Rotate bearer token</Eyebrow>
        <p
          style={{
            fontSize: 12,
            color: 'var(--text-muted)',
            margin: '0 0 14px',
          }}
        >
          Generates a new <code>LOCAL_BEARER_TOKEN</code>; you paste it into <code>.env</code> and
          restart. Not auto-applied because rotation mid-flight invalidates every in-flight worker
          request.
        </p>
        <TokenRotator />
      </section>
    </main>
  );
}
