import { db } from '@/db/client';
import { llmProviders } from '@/db/schema';
import { decryptSecret } from '@/lib/secret-box';
import { asc, desc, eq } from 'drizzle-orm';
import { AnthropicProvider } from './anthropic';
import { CodexCliProvider } from './codex';
import { OpenAICompatibleProvider } from './openai_compatible';
import type { LlmProvider, ProviderConfig } from './types';

type ProviderRecord = typeof llmProviders.$inferSelect;

/** Instantiate the right provider class for a config. */
export function providerFromConfig(config: ProviderConfig): LlmProvider {
  if (config.type === 'anthropic') return new AnthropicProvider(config);
  if (config.type === 'codex-cli') return new CodexCliProvider(config);
  return new OpenAICompatibleProvider(config);
}

function toConfig(r: ProviderRecord): ProviderConfig {
  return {
    name: r.name,
    type: r.type,
    baseUrl: r.baseUrl,
    apiKey: decryptSecret(r.apiKey), // #14: keys are encrypted at rest
    model: r.model,
    maxTokens: r.maxTokens,
    temperature: r.temperature,
  };
}

/**
 * Pure selection: pick the best enabled provider for a purpose. ELIGIBLE
 * candidates are only: an exact purpose match, an `all`-purpose provider, or a
 * provider flagged `is_default`. A provider configured for an *unrelated*
 * profile is never eligible (#17) — so `premium_multimodal` won't quietly
 * serve `standard_audio_visual`. Order: exact → all → default → lowest id.
 * Returns null when nothing eligible; caller falls back to env. Exported for tests.
 */
export function selectProvider<
  T extends Pick<ProviderRecord, 'id' | 'enabled' | 'purpose' | 'isDefault'>,
>(records: T[], purpose: string): T | null {
  const eligible = records.filter(
    (r) =>
      r.enabled &&
      ((purpose !== 'all' && r.purpose === purpose) || r.purpose === 'all' || r.isDefault),
  );
  if (eligible.length === 0) return null;
  const score = (r: T): number => {
    if (purpose !== 'all' && r.purpose === purpose) return 3;
    if (r.purpose === 'all') return 2;
    return 1; // default-flagged fallback
  };
  return (
    [...eligible].sort((a, b) => {
      const s = score(b) - score(a);
      if (s !== 0) return s;
      const d = Number(b.isDefault) - Number(a.isDefault);
      if (d !== 0) return d;
      return a.id - b.id;
    })[0] ?? null
  );
}

/**
 * Env-based fallback so a fresh install (empty llm_providers table) still
 * works with zero config — mirrors the old LM Studio behavior.
 */
function envDefaultConfig(purpose: string): ProviderConfig {
  const premium = purpose === 'premium_multimodal';
  const baseUrl =
    process.env.OPENCLAW_BASE_URL ??
    (premium ? process.env.LM_STUDIO_PREMIUM_HOST : process.env.LM_STUDIO_DEFAULT_HOST) ??
    'http://localhost:1234/v1';
  const model =
    (premium ? process.env.LM_STUDIO_PREMIUM_MODEL : process.env.LM_STUDIO_DEFAULT_MODEL) ??
    'qwen/qwen3-32b';
  return {
    name: process.env.OPENCLAW_BASE_URL ? 'OpenClaw (env)' : 'LM Studio (env)',
    type: 'openai-compatible',
    baseUrl,
    apiKey: '',
    model,
    maxTokens: 2048,
    temperature: 0.5,
  };
}

/**
 * Seed a default LM Studio provider row from env when the table is empty, so
 * the providers UI isn't blank on first run and behavior matches the
 * previous env-only setup. Idempotent (no-op once any row exists).
 */
export async function seedDefaultProviderIfEmpty(): Promise<void> {
  const [any] = await db.select({ id: llmProviders.id }).from(llmProviders).limit(1);
  if (any) return;
  const cfg = envDefaultConfig('all');
  await db.insert(llmProviders).values({
    name: cfg.name,
    type: cfg.type,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: cfg.model,
    isDefault: true,
    enabled: true,
    purpose: 'all',
    maxTokens: 8192,
    temperature: cfg.temperature,
  });
}

/**
 * Resolve a provider by numeric id, or by purpose (a processing profile or
 * 'all'). Falls back to the env LM Studio config if no rows exist.
 */
export async function getProvider(purposeOrId?: string | number): Promise<LlmProvider> {
  if (typeof purposeOrId === 'number') {
    const [rec] = await db
      .select()
      .from(llmProviders)
      .where(eq(llmProviders.id, purposeOrId))
      .limit(1);
    if (!rec) throw new Error(`getProvider: no provider with id ${purposeOrId}`);
    return providerFromConfig(toConfig(rec));
  }

  const purpose = purposeOrId ?? 'all';
  const records = await db
    .select()
    .from(llmProviders)
    .orderBy(desc(llmProviders.isDefault), asc(llmProviders.id));

  if (records.length === 0) {
    // Zero-config: synthesize from env (and seed a row for next time).
    await seedDefaultProviderIfEmpty().catch(() => {});
    return providerFromConfig(envDefaultConfig(purpose));
  }
  const picked = selectProvider(records, purpose);
  if (!picked) {
    return providerFromConfig(envDefaultConfig(purpose));
  }
  return providerFromConfig(toConfig(picked));
}
