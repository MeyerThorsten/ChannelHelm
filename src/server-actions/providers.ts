'use server';

import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { decryptSecret, encryptSecret } from '@/lib/secret-box';
import { imageProviderFromConfig } from '@workers/integrations/image/get_image_provider';
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
  const category = String(formData.get('category') ?? 'text') === 'image' ? 'image' : 'text';

  await db.transaction(async (tx) => {
    if (isDefault) {
      // is_default is scoped per category (one default LLM + one default image).
      await tx
        .update(llmProviders)
        .set({ isDefault: false })
        .where(eq(llmProviders.category, category));
    }
    await tx.insert(llmProviders).values({
      name,
      category,
      type,
      baseUrl,
      apiKey: encryptSecret(String(formData.get('apiKey') ?? '')),
      model,
      purpose: String(formData.get('purpose') ?? 'all'),
      maxTokens: num(formData.get('maxTokens'), 2048),
      maxConcurrent: num(formData.get('maxConcurrent'), 0),
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
  const category = String(formData.get('category') ?? 'text') === 'image' ? 'image' : 'text';
  // #14: a blank API key on edit PRESERVES the saved one (the form never
  // receives the existing key, so blank == "unchanged"). A new value replaces it.
  const submittedKey = String(formData.get('apiKey') ?? '');

  await db.transaction(async (tx) => {
    if (isDefault) {
      await tx
        .update(llmProviders)
        .set({ isDefault: false })
        .where(eq(llmProviders.category, category));
    }
    const values: Record<string, unknown> = {
      name,
      category,
      type,
      baseUrl,
      model,
      purpose: String(formData.get('purpose') ?? 'all'),
      maxTokens: num(formData.get('maxTokens'), 2048),
      maxConcurrent: num(formData.get('maxConcurrent'), 0),
      temperature: num(formData.get('temperature'), 0.5),
      isDefault,
      enabled: formData.get('enabled') === 'on',
      updatedAt: sql`now()`,
    };
    if (submittedKey.length > 0) values.apiKey = encryptSecret(submittedKey);
    await tx.update(llmProviders).set(values).where(eq(llmProviders.id, id));
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
  if (rec.category === 'image') {
    // Image providers (Runware) can't be live-tested without spending credits;
    // confirm an API key is present instead.
    const img = imageProviderFromConfig({
      name: rec.name,
      type: rec.type,
      baseUrl: rec.baseUrl,
      apiKey: decryptSecret(rec.apiKey),
      model: rec.model,
    });
    const r = await img.testConnection();
    if (r.ok)
      return `✓ ${rec.name} configured (${rec.model}) — image providers aren't live-tested to avoid charges`;
    throw new Error(r.error ?? 'no API key configured');
  }
  const provider = providerFromConfig({
    name: rec.name,
    type: rec.type,
    baseUrl: rec.baseUrl,
    apiKey: decryptSecret(rec.apiKey),
    model: rec.model,
    maxTokens: rec.maxTokens,
    temperature: rec.temperature,
  });
  const r = await provider.testConnection();
  if (r.ok) return `✓ OK — responded as ${r.model ?? rec.model}`;
  throw new Error(r.error ?? 'connection failed');
}
