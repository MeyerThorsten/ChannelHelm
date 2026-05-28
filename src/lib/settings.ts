/**
 * Runtime-editable settings, hydrated into `process.env` so every existing
 * `process.env.X` reader keeps working unchanged. Updates from the
 * `/settings` UI propagate across the Next.js + worker processes via
 * pg_notify on the channel `chs_settings` (payload = the changed key).
 *
 * Design notes:
 *  - DB wins over .env. If a settings row exists, its value overrides whatever
 *    .env had at boot — that's the whole point of the feature.
 *  - Empty / null DB values leave the env reading alone (so an unset row
 *    doesn't clobber a value the operator put in .env).
 *  - Secrets are stored AES-256-GCM via `secret-box`. The UI mints/edits keys
 *    via `setSetting`, never by writing the table directly.
 *  - LISTEN holds a connection — we open a dedicated `pg.Client` for it,
 *    separate from Drizzle's pool. Errors auto-reconnect after 5s.
 */

import { db } from '@/db/client';
import { settings } from '@/db/schema';
import pg from 'pg';
import { eq } from 'drizzle-orm';
import { decryptSecret, encryptSecret, isEncrypted } from './secret-box';

export type SettingKind = 'string' | 'number' | 'boolean';

export type SettingDef = {
  key: string;
  sensitive: boolean;
  kind: SettingKind;
  help: string;
  /** Boot-only keys appear on /settings as read-only and refuse PUT. */
  bootOnly?: boolean;
};

/**
 * The full catalogue of keys the /settings page knows about. Anything not
 * listed here is hidden from the UI and refused by `setSetting()`.
 */
export const SETTINGS_CATALOGUE: SettingDef[] = [
  // ── External integrations ─────────────────────────────────────────────────
  { key: 'ZERNIO_API_KEY', sensitive: true, kind: 'string', help: 'Required for dispatch → Zernio (social/clip publishing).' },
  { key: 'ZERNIO_WEBHOOK_SECRET', sensitive: true, kind: 'string', help: 'When set, /api/webhooks/zernio requires a matching x-zernio-signature header (HMAC SHA-256, fail-closed).' },
  { key: 'DOJOCLAW_API_URL', sensitive: false, kind: 'string', help: 'LAN URL for DojoClaw, e.g. http://m4max.local:8788.' },
  { key: 'DOJOCLAW_API_KEY', sensitive: true, kind: 'string', help: 'Required for dispatch → DojoClaw (article briefs).' },
  { key: 'DOJOCLAW_WEBHOOK_SECRET', sensitive: true, kind: 'string', help: 'When set, /api/webhooks/dojoclaw requires a matching x-dojoclaw-signature header.' },
  { key: 'HF_TOKEN', sensitive: true, kind: 'string', help: 'Enables ml/diarize.py speaker labels. Token must have pyannote model licenses accepted.' },
  // ── Public exposure ──────────────────────────────────────────────────────
  { key: 'CLOUDFLARE_TUNNEL_HOSTNAME', sensitive: false, kind: 'string', help: 'Public base URL for inbound webhooks + signed /media/* URLs (e.g. https://media.channelhelm.com).' },
  { key: 'MEDIA_URL_SECRET', sensitive: true, kind: 'string', help: 'HMAC key for signed media URLs. Required when MEDIA_REQUIRE_SIGNATURE=1.' },
  { key: 'MEDIA_REQUIRE_SIGNATURE', sensitive: false, kind: 'boolean', help: 'Reject unsigned /media/* requests. Turn on before exposing the tunnel.' },
  { key: 'ALLOW_UNSIGNED_WEBHOOKS', sensitive: false, kind: 'boolean', help: 'Local-only escape hatch: accept inbound webhooks without HMAC. Use only for smoke tests.' },
  { key: 'MAX_UPLOAD_BYTES', sensitive: false, kind: 'number', help: 'Hard cap on /api/uploads body size (bytes). Default 2 GiB.' },

  // ── YouTube Direct (Data API v3) ──────────────────────────────────────────
  { key: 'GOOGLE_OAUTH_CLIENT_ID', sensitive: false, kind: 'string', help: 'OAuth 2.0 Client ID from Google Cloud Console (APIs & Services → Credentials). One client supports all brands. Required for /brands/[id] → Connect YouTube.' },
  { key: 'GOOGLE_OAUTH_CLIENT_SECRET', sensitive: true, kind: 'string', help: 'OAuth 2.0 Client secret paired with GOOGLE_OAUTH_CLIENT_ID. Never sent to the browser; signed exchanges only.' },

  // ── Storage lifecycle (Option B: post-publish archive) ───────────────────
  // When ARCHIVE_ROOT is unset, the recurring enqueuer skips archive_package
  // entirely — the feature is opt-in by virtue of providing an external path.
  { key: 'ARCHIVE_AFTER_DAYS', sensitive: false, kind: 'number', help: 'Days since first dispatch before a package becomes eligible for archive. Default 14. Eligibility query: latest dispatch older than this AND archived_at IS NULL.' },
  { key: 'ARCHIVE_DELETE_CLIPS', sensitive: false, kind: 'boolean', help: 'When true, archive_package DELETES rendered clip MP4s instead of moving them to ARCHIVE_ROOT. Source MP4 still moves either way (clip_render needs it for re-renders). Default false.' },

  // ── Boot-only (read-only in UI) ──────────────────────────────────────────
  { key: 'DATABASE_URL', sensitive: true, kind: 'string', bootOnly: true, help: 'Postgres connection string. Boot-only — edit .env and restart.' },
  { key: 'MEDIA_ROOT', sensitive: false, kind: 'string', bootOnly: true, help: 'Where ingest writes media. Boot-only — workers spawn subprocesses that resolve paths against this at startup.' },
  { key: 'ARCHIVE_ROOT', sensitive: false, kind: 'string', bootOnly: true, help: 'External-drive path for the post-publish archive worker. Unset = archiving disabled. Boot-only — workers cache the absolute path at startup and refuse to operate when it suddenly changes mid-run (e.g. drive unmounted).' },
  { key: 'LOCAL_BEARER_TOKEN', sensitive: true, kind: 'string', bootOnly: true, help: 'API bearer token. Boot-only — rotation invalidates every worker in flight. Use the Rotate button to mint, paste into .env, restart.' },
  { key: 'PROVIDER_SECRET_KEY', sensitive: true, kind: 'string', bootOnly: true, help: 'AES-256-GCM key that wraps llm_providers.api_key. Boot-only — rotating it locks every saved provider key out until re-encryption.' },
];

const CATALOGUE_BY_KEY: Map<string, SettingDef> = new Map(SETTINGS_CATALOGUE.map((s) => [s.key, s]));

export function getSettingDef(key: string): SettingDef | undefined {
  return CATALOGUE_BY_KEY.get(key);
}

/** Editable keys (everything in the catalogue except boot-only). */
export function editableKeys(): SettingDef[] {
  return SETTINGS_CATALOGUE.filter((s) => !s.bootOnly);
}

/** Boot-only keys (read-only on /settings). */
export function bootOnlyKeys(): SettingDef[] {
  return SETTINGS_CATALOGUE.filter((s) => s.bootOnly);
}

// ── Hydration ──────────────────────────────────────────────────────────────

/**
 * Read every settings row and copy values into `process.env`. Called once at
 * boot from `workers/runner.ts` (the worker process opens a LISTEN client
 * via `subscribeSettingsChanges()` and stays live). The Next.js process uses
 * the lazy `ensureHydrated()` wrapper instead — Turbopack's instrumentation
 * bundling doesn't tolerate the Node-only `pg` + `dotenv` import chain.
 *
 * Rows with null/empty values leave the env reading alone — an unset row
 * never clobbers what the operator put in .env.
 */
export async function loadSettingsIntoEnv(): Promise<void> {
  const rows = await db.select().from(settings);
  for (const row of rows) {
    applyRowToEnv(row.key, row.value, row.encrypted);
  }
}

let hydrated = false;
let hydratePromise: Promise<void> | null = null;

/**
 * Idempotent, lazy hydration for the Next.js process. Called from the
 * `/api/settings` GET (so the page always reflects DB truth) and from
 * `setSetting()` itself (defensive — the in-handler `applyRowToEnv` would
 * cover a fresh write, but a write to a key that already had a DB value
 * the process never loaded would otherwise look like "first save".)
 *
 * Concurrent callers share a single in-flight promise so we don't
 * thunder-herd the DB on the first request after a cold start.
 */
export async function ensureHydrated(): Promise<void> {
  if (hydrated) return;
  if (!hydratePromise) {
    hydratePromise = loadSettingsIntoEnv()
      .then(() => {
        hydrated = true;
      })
      .catch((err) => {
        // Reset so the next request retries; surface the error to the caller.
        hydratePromise = null;
        throw err;
      });
  }
  await hydratePromise;
}

function applyRowToEnv(key: string, value: string | null, encrypted: boolean): void {
  if (value == null || value === '') return; // never clobber env with empty
  const plain = encrypted ? decryptSecret(value) : value;
  process.env[key] = plain;
}

/** Refresh a single key from DB into `process.env`. Used by the LISTEN callback. */
export async function refreshSettingIntoEnv(key: string): Promise<void> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  if (!row) {
    // Row was deleted — leave env as it is. (We never reverse-engineer the
    // original .env value; the operator can restart to pick that back up.)
    return;
  }
  applyRowToEnv(row.key, row.value, row.encrypted);
}

// ── Writes ─────────────────────────────────────────────────────────────────

/**
 * Upsert a setting + fire pg_notify so every subscribed process refreshes
 * its env on the same key. Encrypts sensitive values via `secret-box`.
 *
 * Throws if `key` isn't in the catalogue, or if it's marked `bootOnly`.
 */
export async function setSetting(key: string, value: string): Promise<void> {
  const def = CATALOGUE_BY_KEY.get(key);
  if (!def) throw new Error(`settings: unknown key '${key}'`);
  if (def.bootOnly) throw new Error(`settings: '${key}' is boot-only — edit .env and restart`);
  // Defensive: a fresh Next.js process may not yet hold the existing DB rows
  // in its env (we hydrate lazily on GET). Ensure that before we mutate, so
  // we don't end up with a partially-hydrated process.env.
  await ensureHydrated();

  // Light coercion: trim strings; reject obvious garbage for typed fields.
  let stored = value.trim();
  if (def.kind === 'number' && stored !== '') {
    const n = Number(stored);
    if (!Number.isFinite(n)) throw new Error(`settings: '${key}' expects a number, got '${value}'`);
    stored = String(n);
  }
  if (def.kind === 'boolean' && stored !== '') {
    // Accept 1/0, true/false, on/off — normalise to 1/0 (env convention).
    const t = stored.toLowerCase();
    if (['1', 'true', 'on', 'yes'].includes(t)) stored = '1';
    else if (['0', 'false', 'off', 'no', ''].includes(t)) stored = '0';
    else throw new Error(`settings: '${key}' expects a boolean, got '${value}'`);
  }

  const encryptedValue = def.sensitive && stored !== '' ? encryptSecret(stored) : stored;

  await db
    .insert(settings)
    .values({ key, value: encryptedValue, encrypted: def.sensitive })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value: encryptedValue, encrypted: def.sensitive, updatedAt: new Date() },
    });

  // Apply locally immediately (so the response reflects the change before
  // the LISTEN round-trip), then NOTIFY peers.
  applyRowToEnv(key, encryptedValue, def.sensitive);
  await notifyPeers(key);
}

async function notifyPeers(key: string): Promise<void> {
  // pg_notify is fire-and-forget; payload is the key so peers refresh just
  // that one row instead of reloading the whole table.
  await db.execute(/* sql */ `select pg_notify('chs_settings', ${escapeLiteral(key)})`);
}

function escapeLiteral(s: string): string {
  // The key is from a known catalogue; this is belt-and-braces for the
  // pg_notify payload literal. Single quotes only.
  return `'${s.replace(/'/g, "''")}'`;
}

// ── Live subscribe ─────────────────────────────────────────────────────────

let subscriberClient: pg.Client | null = null;
let subscriberReconnectTimer: NodeJS.Timeout | null = null;
let subscriberState: 'pending' | 'subscribed' | 'unavailable' = 'pending';

/**
 * Status of the LISTEN connection on *this* process. The /settings UI uses
 * this to decide whether to show the "restart needed" banner — a freshly
 * pulled checkout that hasn't been restarted since the boot hook landed
 * will read 'pending' (instrumentation never ran).
 */
export function getSubscriberStatus(): 'pending' | 'subscribed' | 'unavailable' {
  return subscriberState;
}

/**
 * Open a dedicated `pg.Client` (separate from Drizzle's pool — LISTEN holds
 * the connection) and LISTEN on `chs_settings`. On each notification, refresh
 * that one key into `process.env`. Auto-reconnects on error after 5s.
 *
 * Idempotent: safe to call from multiple boot hooks.
 */
export async function subscribeSettingsChanges(): Promise<void> {
  if (subscriberClient) return;
  if (!process.env.DATABASE_URL) return;

  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  subscriberClient = client;

  client.on('notification', (msg) => {
    if (msg.channel !== 'chs_settings' || !msg.payload) return;
    refreshSettingIntoEnv(msg.payload).catch((err) => {
      console.error(`[settings] refresh failed for ${msg.payload}:`, err);
    });
  });

  client.on('error', (err) => {
    console.error('[settings] subscriber error, reconnecting in 5s:', err.message);
    subscriberClient = null;
    if (subscriberReconnectTimer) clearTimeout(subscriberReconnectTimer);
    subscriberReconnectTimer = setTimeout(() => {
      subscribeSettingsChanges().catch(() => {});
    }, 5000);
  });

  try {
    await client.connect();
    await client.query('LISTEN chs_settings');
    subscriberState = 'subscribed';
    console.log('[settings] subscribed to chs_settings');
  } catch (err) {
    console.error('[settings] failed to subscribe:', err);
    subscriberClient = null;
    subscriberState = 'unavailable';
    if (subscriberReconnectTimer) clearTimeout(subscriberReconnectTimer);
    subscriberReconnectTimer = setTimeout(() => {
      subscribeSettingsChanges().catch(() => {});
    }, 5000);
  }
}

// ── Table existence probe (for the migration banner) ──────────────────────

/**
 * Cheap "does the table exist yet?" check used by /settings to surface a
 * one-click "run pnpm db:migrate" banner on a fresh checkout where the
 * migration hasn't been applied. Returns true on any non-missing error
 * (we don't want to misreport unrelated DB errors as a missing table).
 */
export async function settingsTableExists(): Promise<boolean> {
  try {
    await db.select().from(settings).limit(1);
    return true;
  } catch (err) {
    const code = (err as { code?: string }).code;
    // 42P01 = undefined_table
    if (code === '42P01') return false;
    // Any other DB error: pessimistically assume the table is fine; the
    // real error will surface elsewhere with a clearer message.
    return true;
  }
}

// ── UI-facing helpers ──────────────────────────────────────────────────────

export const MASK = '••••••••';

/**
 * Effective value: what the current `process.env` resolves to AFTER hydration.
 * Returns a `{ value, isSet, fromDb }` triple — `fromDb` is true when a
 * settings row exists (so the UI can distinguish "saved in DB" from "still
 * coming from .env").
 */
export async function getEffectiveSetting(
  key: string,
): Promise<{ value: string | null; isSet: boolean; fromDb: boolean }> {
  const [row] = await db.select().from(settings).where(eq(settings.key, key)).limit(1);
  const envValue = process.env[key] ?? null;
  const fromDb = !!(row && row.value);
  return { value: envValue, isSet: envValue != null && envValue !== '', fromDb };
}

/** Mask a secret for the GET response. */
export function maskValue(value: string | null | undefined): string {
  if (!value) return '';
  return MASK;
}

/** True iff a submitted value is the masked placeholder (i.e. user didn't edit). */
export function isMaskPlaceholder(value: string): boolean {
  return value === MASK;
}

/** Re-export so callers don't have to import secret-box separately. */
export { isEncrypted };
