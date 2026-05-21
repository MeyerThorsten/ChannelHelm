import { ProviderActions } from '@/components/providers/ProviderActions';
import { ProviderForm } from '@/components/providers/ProviderForm';
import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { createProviderFromForm } from '@/server-actions/providers';
import { seedDefaultProviderIfEmpty } from '@workers/integrations/llm/get_provider';
import { asc, desc } from 'drizzle-orm';

export const dynamic = 'force-dynamic';

export default async function ProvidersPage() {
  // Seed the env LM Studio provider on first visit so the list isn't blank.
  // (Plain seed — calling a server action's revalidatePath during render is illegal.)
  await seedDefaultProviderIfEmpty().catch(() => {});
  const rows = await db
    .select()
    .from(llmProviders)
    .orderBy(desc(llmProviders.isDefault), asc(llmProviders.id));

  return (
    <main className="mx-auto max-w-4xl px-6 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">LLM Providers</h1>
        <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
          Point ChannelHelm at OpenAI, Anthropic, OpenRouter, Ollama, LM Studio, or OpenClaw. A
          provider whose <em>purpose</em> matches a processing profile is preferred; otherwise the
          default is used.
        </p>
      </header>

      <section className="mb-8 space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-zinc-500">No providers yet — add one below.</p>
        ) : (
          <ul className="space-y-2">
            {rows.map((p) => (
              <li
                key={p.id}
                className="flex items-start justify-between gap-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{p.name}</span>
                    {p.isDefault && (
                      <span className="rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-700 dark:bg-sky-950/50 dark:text-sky-300">
                        default
                      </span>
                    )}
                    {!p.enabled && (
                      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-500 dark:bg-zinc-800">
                        disabled
                      </span>
                    )}
                  </div>
                  <div className="mt-1 font-mono text-xs text-zinc-500">
                    {[p.type, p.model, p.purpose, p.baseUrl].filter(Boolean).join(' · ')}
                  </div>
                </div>
                <ProviderActions id={p.id} isDefault={p.isDefault} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-zinc-200 bg-white p-5 dark:border-zinc-800 dark:bg-zinc-900">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-zinc-500">
          Add provider
        </h2>
        <ProviderForm action={createProviderFromForm} submitLabel="Add provider" />
      </section>
    </main>
  );
}
