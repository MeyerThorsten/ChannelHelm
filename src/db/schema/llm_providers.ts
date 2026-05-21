import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

/**
 * Configurable LLM providers — modeled on DojoClaw's LLMProvider. Lets the
 * operator point ChannelHelm at OpenAI, Anthropic, OpenRouter, Ollama,
 * LM Studio, OpenClaw, etc. without code changes.
 *
 *   type    — 'openai-compatible' (OpenAI/OpenRouter/Ollama/LM Studio/OpenClaw)
 *             | 'anthropic' (Messages API)
 *   purpose — 'all' or a processing profile (fast_audio_only |
 *             standard_audio_visual | premium_multimodal). Lets a profile
 *             route to a specific provider; falls back to the default.
 */
export const llmProviders = pgTable(
  'llm_providers',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    name: text('name').notNull(),
    type: text('type').notNull().default('openai-compatible'),
    baseUrl: text('base_url').notNull(),
    apiKey: text('api_key').notNull().default(''),
    model: text('model').notNull(),
    isDefault: boolean('is_default').notNull().default(false),
    enabled: boolean('enabled').notNull().default(true),
    purpose: text('purpose').notNull().default('all'),
    maxTokens: integer('max_tokens').notNull().default(2048),
    temperature: doublePrecision('temperature').notNull().default(0.5),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_llm_providers_enabled').on(t.enabled).where(sql`${t.enabled} = TRUE`),
    index('idx_llm_providers_purpose').on(t.purpose),
  ],
);
