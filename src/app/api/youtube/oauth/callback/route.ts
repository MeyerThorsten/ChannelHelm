import { youtubeOauthCallback } from '@workers/integrations/youtube';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/youtube/oauth/callback?code=…&state=brd_…
 *
 * Google redirects back here after consent. Exchanges the auth code for
 * tokens, encrypts the refresh_token, persists on the brand row, then
 * redirects the operator back to the brand page with a success flag.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const code = req.nextUrl.searchParams.get('code');
  const brandId = req.nextUrl.searchParams.get('state');
  const errorParam = req.nextUrl.searchParams.get('error');

  if (errorParam) {
    // User clicked "Cancel" on the Google consent screen.
    const target = brandId
      ? `/brands/${brandId}?yt_oauth=cancelled`
      : `/brands?yt_oauth=cancelled`;
    return NextResponse.redirect(new URL(target, req.nextUrl.origin));
  }
  if (!code || !brandId?.startsWith('brd_')) {
    return NextResponse.json({ error: 'missing code or state' }, { status: 400 });
  }

  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/youtube/oauth/callback`;
  try {
    const { channelTitle } = await youtubeOauthCallback(brandId, code, redirectUri);
    const qs = channelTitle
      ? `yt_oauth=connected&channel=${encodeURIComponent(channelTitle)}`
      : `yt_oauth=connected`;
    return NextResponse.redirect(new URL(`/brands/${brandId}?${qs}`, req.nextUrl.origin));
  } catch (err) {
    const msg = encodeURIComponent((err as Error).message);
    return NextResponse.redirect(
      new URL(`/brands/${brandId}?yt_oauth=error&msg=${msg}`, req.nextUrl.origin),
    );
  }
}
