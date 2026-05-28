import { db } from '@/db/client';
import { youtubeOauthStates } from '@/db/schema';
import { hydrateRuntimeSettingsForRoute } from '@/lib/settings';
import { youtubeOauthCallback } from '@workers/integrations/youtube';
import { and, eq, isNull } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/youtube/oauth/callback?code=…&state=yt_…
 *
 * Google redirects back here after consent. Exchanges the auth code for
 * tokens, encrypts the refresh_token, persists on the brand row, then
 * redirects the operator back to the brand page with a success flag.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  await hydrateRuntimeSettingsForRoute('youtube:oauth:callback');

  const code = req.nextUrl.searchParams.get('code');
  const state = req.nextUrl.searchParams.get('state');
  const errorParam = req.nextUrl.searchParams.get('error');

  if (errorParam) {
    // User clicked "Cancel" on the Google consent screen.
    const row = state ? await readOauthState(state).catch(() => null) : null;
    const target = row?.brandId
      ? `/brands/${row.brandId}?yt_oauth=cancelled`
      : '/brands?yt_oauth=cancelled';
    return NextResponse.redirect(new URL(target, req.nextUrl.origin));
  }
  if (!code || !state?.startsWith('yt_')) {
    return NextResponse.json({ error: 'missing code or state' }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/youtube/oauth/callback`;
  try {
    const oauthState = await consumeOauthState(state);
    if (oauthState.redirectUri !== redirectUri) {
      throw new Error('OAuth redirect URI mismatch');
    }
    const { channelTitle } = await youtubeOauthCallback(
      oauthState.brandId,
      code,
      redirectUri,
      oauthState.expectedChannelId,
    );
    const qs = channelTitle
      ? `yt_oauth=connected&channel=${encodeURIComponent(channelTitle)}`
      : 'yt_oauth=connected';
    return NextResponse.redirect(
      new URL(`/brands/${oauthState.brandId}?${qs}`, req.nextUrl.origin),
    );
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message);
    const row = state ? await readOauthState(state).catch(() => null) : null;
    const target = row?.brandId ? `/brands/${row.brandId}` : '/brands';
    return NextResponse.redirect(
      new URL(`${target}?yt_oauth=error&msg=${msg}`, req.nextUrl.origin),
    );
  }
}

async function readOauthState(state: string) {
  const [row] = await db
    .select()
    .from(youtubeOauthStates)
    .where(eq(youtubeOauthStates.state, state))
    .limit(1);
  return row ?? null;
}

async function consumeOauthState(state: string) {
  const row = await readOauthState(state);
  if (!row) throw new Error('unknown OAuth state');
  if (row.consumedAt) throw new Error('OAuth state already used');
  if (row.expiresAt.getTime() < Date.now()) throw new Error('OAuth state expired');

  const [consumed] = await db
    .update(youtubeOauthStates)
    .set({ consumedAt: new Date() })
    .where(and(eq(youtubeOauthStates.state, state), isNull(youtubeOauthStates.consumedAt)))
    .returning();
  if (!consumed) throw new Error('OAuth state already used');
  return consumed;
}
