import { requireAuth } from '@/lib/auth';
import {
  MASK,
  SETTINGS_CATALOGUE,
  ensureHydrated,
  getSettingDef,
  getSubscriberStatus,
  isMaskPlaceholder,
  maskValue,
  setSetting,
  settingsTableExists,
} from '@/lib/settings';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET — list every catalogued setting, with its effective value (from
 * `process.env` after boot-hydration) and a `bootOnly` flag. Sensitive
 * values are masked.
 *
 * Modeled on dojoclaw's /api/settings GET. We additionally return the
 * `bootOnly` flag so the UI can render those rows read-only.
 */
export async function GET(req: NextRequest): Promise<Response> {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  // Lazy hydrate so the page always reflects DB truth even if this Next.js
  // process started after rows already existed. No-op once hydrated.
  const migrationNeeded = !(await settingsTableExists());
  if (!migrationNeeded) {
    await ensureHydrated().catch(() => {
      // Hydration may still race the migration on first boot; the banner
      // handles the user-visible side. Surface nothing here.
    });
  }
  const items = SETTINGS_CATALOGUE.map((def) => {
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
    };
  });
  return NextResponse.json({ items, migrationNeeded, subscriberStatus: getSubscriberStatus() });
}

/**
 * PUT — `{ KEY: value, KEY2: value }`. Mask-placeholder submissions are
 * ignored (DojoClaw pattern: re-submitting `••••••••` means "no change").
 * Boot-only keys are refused with 400.
 */
export async function PUT(req: NextRequest): Promise<Response> {
  const auth = requireAuth(req);
  if (!auth.ok) return auth.response;

  const body = (await req.json()) as Record<string, unknown>;
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'body must be an object of key→value' }, { status: 400 });
  }

  const changed: string[] = [];
  const errors: { key: string; error: string }[] = [];

  for (const [key, raw] of Object.entries(body)) {
    const def = getSettingDef(key);
    if (!def) {
      errors.push({ key, error: 'unknown setting' });
      continue;
    }
    if (def.bootOnly) {
      errors.push({ key, error: 'boot-only — edit .env and restart' });
      continue;
    }
    const value = String(raw ?? '');
    // Re-submitting the mask placeholder means the operator didn't edit
    // the field; skip without touching the saved value.
    if (def.sensitive && isMaskPlaceholder(value)) continue;
    try {
      await setSetting(key, value);
      changed.push(key);
    } catch (err) {
      errors.push({ key, error: (err as Error).message });
    }
  }

  if (errors.length > 0 && changed.length === 0) {
    return NextResponse.json({ error: 'no changes applied', errors }, { status: 400 });
  }
  return NextResponse.json({ ok: true, changed, errors });
}

// The mask token surfaced for the form layer so it can re-use the same string.
export const MASK_TOKEN = MASK;
