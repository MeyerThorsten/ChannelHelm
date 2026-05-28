import { ProviderActions } from '@/components/providers/ProviderActions';
import { ProviderForm } from '@/components/providers/ProviderForm';
import { Eyebrow } from '@/components/ui';
import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { createProviderFromForm } from '@/server-actions/providers';
import { seedDefaultProviderIfEmpty } from '@workers/integrations/llm/get_provider';
import { asc, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function ProvidersPage() {
  await seedDefaultProviderIfEmpty().catch(() => {});
  const rows = await db
    .select()
    .from(llmProviders)
    .orderBy(desc(llmProviders.isDefault), asc(llmProviders.id));

  return (
    <main style={{ maxWidth: 960, margin: '0 auto', padding: '32px 32px 80px' }}>
      <Eyebrow>Configuration</Eyebrow>
      <h1
        className="serif"
        style={{ fontSize: 32, fontWeight: 400, margin: '4px 0 6px', letterSpacing: -0.3 }}
      >
        LLM Providers
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '0 0 24px', maxWidth: 640 }}>
        Point ChannelHelm at OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, OpenClaw, or the
        local Codex CLI. A provider whose <em>purpose</em> matches a processing profile is
        preferred; otherwise the default is used.
      </p>

      <section style={{ marginBottom: 28, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {rows.length === 0 ? (
          <div style={{ fontSize: 13, color: 'var(--text-faint)' }}>
            No providers yet — add one below.
          </div>
        ) : (
          rows.map((p) => (
            <div
              key={p.id}
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 16,
                padding: 14,
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 10,
              }}
            >
              <div style={{ minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 14, fontWeight: 600 }}>{p.name}</span>
                  {(() => {
                    const isImage = p.category === 'image';
                    return (
                      <span
                        style={{
                          fontSize: 9,
                          fontFamily: 'var(--font-mono)',
                          padding: '1px 6px',
                          borderRadius: 999,
                          color: isImage ? 'var(--accent)' : 'var(--text-faint)',
                          background: isImage
                            ? 'color-mix(in oklab, var(--accent) 14%, transparent)'
                            : 'var(--bg-elev-2)',
                          border: isImage
                            ? '1px solid color-mix(in oklab, var(--accent) 28%, transparent)'
                            : '1px solid var(--border)',
                        }}
                      >
                        {isImage ? 'image' : 'LLM'}
                      </span>
                    );
                  })()}
                  {p.isDefault && (
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: 'var(--font-mono)',
                        padding: '1px 6px',
                        borderRadius: 999,
                        color: 'var(--accent)',
                        background: 'color-mix(in oklab, var(--accent) 14%, transparent)',
                        border: '1px solid color-mix(in oklab, var(--accent) 28%, transparent)',
                      }}
                    >
                      default
                    </span>
                  )}
                  {!p.enabled && (
                    <span
                      style={{
                        fontSize: 9,
                        fontFamily: 'var(--font-mono)',
                        padding: '1px 6px',
                        borderRadius: 999,
                        color: 'var(--text-faint)',
                        background: 'var(--bg-elev-2)',
                        border: '1px solid var(--border)',
                      }}
                    >
                      disabled
                    </span>
                  )}
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 11,
                    color: 'var(--text-faint)',
                    fontFamily: 'var(--font-mono)',
                  }}
                >
                  {[p.type, p.model, p.purpose, p.baseUrl].filter(Boolean).join(' · ')}
                </div>
              </div>
              <ProviderActions id={p.id} isDefault={p.isDefault} />
            </div>
          ))
        )}
      </section>

      <section
        style={{
          background: 'var(--panel)',
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 18,
        }}
      >
        <Eyebrow style={{ marginBottom: 14 }}>Add provider</Eyebrow>
        <ProviderForm action={createProviderFromForm} submitLabel="Add provider" />
      </section>
    </main>
  );
}
