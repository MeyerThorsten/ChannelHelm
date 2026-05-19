'use server';

import { randomBytes } from 'node:crypto';

/**
 * Generate a fresh local bearer token. The operator copies it into `.env`
 * (`LOCAL_BEARER_TOKEN=`) by hand and restarts the dev/web server.
 *
 * We deliberately do NOT write `.env` from a Server Action:
 *   - It would invalidate the current API session mid-flight, including
 *     any worker that was holding the old token in memory.
 *   - The /settings page already trusts whoever can reach it; if the dev
 *     server is exposed, auto-rotation would be self-locking.
 *
 * Returns the new token as a string the page renders inline. The current
 * token is only displayed masked.
 */
export async function generateBearerToken(): Promise<string> {
  return randomBytes(24).toString('hex');
}
