import { boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

/**
 * Runtime-editable settings, persisted across restarts and synchronised across
 * processes via pg_notify (channel `chs_settings`). On boot, every process
 * calls `loadSettingsIntoEnv()` which copies rows here into `process.env` so
 * every existing `process.env.X` reader keeps working without refactor.
 *
 * `encrypted=true` rows store ciphertext (AES-256-GCM via `secret-box`) for
 * secrets (API keys, webhook signing secrets). Plain rows hold simple URLs
 * and toggles.
 *
 * Not for: boot-only values that the runtime can't safely swap mid-flight
 * (DATABASE_URL, MEDIA_ROOT, LOCAL_BEARER_TOKEN, PROVIDER_SECRET_KEY). Those
 * stay in `.env` — the settings UI surfaces them read-only.
 *
 * Not for: LLM provider configuration. That lives in the `llm_providers`
 * table and is edited at `/providers` (DojoClaw-style — see src/lib/llm in
 * the dojoclaw repo for the reference implementation).
 */
export const settings = pgTable('settings', {
  key: text('key').primaryKey(),
  value: text('value'),
  encrypted: boolean('encrypted').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
