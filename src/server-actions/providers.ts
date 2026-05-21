'use server';

import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { providerFromConfig } from '@workers/integrations/llm/get_provider';
import { fetchAvailableModels } from '@workers/integrations/llm/models';
import { eq, sql } from 'drizzle-orm';
import { revalidatePath } from 'next/cache';

/**
 * List the models a provider endpoint exposes, so the form can offer a
 * dropdown. Best-effort — returns a static fallback if the live fetch fails.
 */
export async function listProviderModels(input: {
  type: string;
  baseUrl: string;
  apiKey: string;
}): Promise<{ models: string[]; fallback?: boolean }> {
  return fetchAvailableModels(input);
}

function num(v: FormDataEntryValue | null, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export async function createProviderFromForm(formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? 'openai-compatible');
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();
  const model = String(formData.get('model') ?? '').trim();
  // codex-cli has no endpoint (it spawns the local CLI), so baseUrl is optional there.
  if (!name || !model || (type !== 'codex-cli' && !baseUrl)) {
    throw new Error('name, model and (for HTTP providers) baseUrl are required');
  }
  const isDefault = formData.get('isDefault') === 'on';

  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx.update(llmProviders).set({ isDefault: false });
    }
    await tx.insert(llmProviders).values({
      name,
      type,
      baseUrl,
      apiKey: String(formData.get('apiKey') ?? ''),
      model,
      purpose: String(formData.get('purpose') ?? 'all'),
      maxTokens: num(formData.get('maxTokens'), 2048),
      temperature: num(formData.get('temperature'), 0.5),
      isDefault,
      enabled: formData.get('enabled') !== 'off',
    });
  });
  revalidatePath('/providers');
}

export async function updateProviderFromForm(id: number, formData: FormData): Promise<void> {
  const name = String(formData.get('name') ?? '').trim();
  const type = String(formData.get('type') ?? 'openai-compatible');
  const baseUrl = String(formData.get('baseUrl') ?? '').trim();
  const model = String(formData.get('model') ?? '').trim();
  if (!name || !model || (type !== 'codex-cli' && !baseUrl)) {
    throw new Error('name, model and (for HTTP providers) baseUrl are required');
  }
  const isDefault = formData.get('isDefault') === 'on';

  await db.transaction(async (tx) => {
    if (isDefault) await tx.update(llmProviders).set({ isDefault: false });
    await tx
      .update(llmProviders)
      .set({
        name,
        type,
        baseUrl,
        apiKey: String(formData.get('apiKey') ?? ''),
        model,
        purpose: String(formData.get('purpose') ?? 'all'),
        maxTokens: num(formData.get('maxTokens'), 2048),
        temperature: num(formData.get('temperature'), 0.5),
        isDefault,
        enabled: formData.get('enabled') === 'on',
        updatedAt: sql`now()`,
      })
      .where(eq(llmProviders.id, id));
  });
  revalidatePath('/providers');
}

export async function deleteProvider(id: number): Promise<void> {
  await db.delete(llmProviders).where(eq(llmProviders.id, id));
  revalidatePath('/providers');
}

export async function setDefaultProvider(id: number): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.update(llmProviders).set({ isDefault: false });
    await tx
      .update(llmProviders)
      .set({ isDefault: true, enabled: true, updatedAt: sql`now()` })
      .where(eq(llmProviders.id, id));
  });
  revalidatePath('/providers');
}

/** Test a saved provider's connection. Returns a friendly result string. */
export async function testProvider(id: number): Promise<string> {
  const [rec] = await db.select().from(llmProviders).where(eq(llmProviders.id, id)).limit(1);
  if (!rec) throw new Error('provider not found');
  const provider = providerFromConfig({
    name: rec.name,
    type: rec.type,
    baseUrl: rec.baseUrl,
    apiKey: rec.apiKey,
    model: rec.model,
    maxTokens: rec.maxTokens,
    temperature: rec.temperature,
  });
  const r = await provider.testConnection();
  if (r.ok) return `✓ OK — responded as ${r.model ?? rec.model}`;
  throw new Error(r.error ?? 'connection failed');
}
