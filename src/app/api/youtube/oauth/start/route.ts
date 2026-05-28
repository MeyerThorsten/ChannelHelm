import { randomBytes } from 'node:crypto';
import { db } from '@/db/client';
import { brands, youtubeOauthStates } from '@/db/schema';
import { hydrateRuntimeSettingsForRoute } from '@/lib/settings';
import { youtubeAuthUrl } from '@workers/integrations/youtube';
import { eq } from 'drizzle-orm';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/youtube/oauth/start?brandId=brd_…
 *
 * Redirects the operator to Google's consent screen. We store a nonce-backed
 * state row so callback replay/cross-brand token binding is rejected.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  await hydrateRuntimeSettingsForRoute('youtube:oauth:start');

  const brandId = req.nextUrl.searchParams.get('brandId');
  if (!brandId?.startsWith('brd_')) {
    return NextResponse.json({ error: 'brandId is required' }, { status: 400 });
  }
  const [brand] = await db
    .select({
      id: brands.id,
      youtubeChannelId: brands.youtubeChannelId,
    })
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1);
  if (!brand) {
    return NextResponse.json({ error: 'brand_not_found' }, { status: 404 });
  }

  // Optional: pre-fill the Google account chooser with this email. Useful
  // when the operator knows which Google account owns the YouTube channel
  // and wants to skip scrolling through the chooser.
  const loginHint = req.nextUrl.searchParams.get('login_hint') ?? undefined;
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/youtube/oauth/callback`;
  try {
    const state = `yt_${randomBytes(24).toString('base64url')}`;
    await db.insert(youtubeOauthStates).values({
      state,
      brandId,
      redirectUri,
      loginHint: loginHint ?? null,
      expectedChannelId: brand.youtubeChannelId ?? null,
      expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    });
    const url = youtubeAuthUrl(state, redirectUri, loginHint);
    return NextResponse.redirect(url);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
