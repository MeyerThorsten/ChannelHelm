import { youtubeAuthUrl } from '@workers/integrations/youtube';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * GET /api/youtube/oauth/start?brandId=brd_…
 *
 * Redirects the operator to Google's consent screen. We pass the brandId in
 * `state` so the callback can map back. Idempotent — re-running just
 * overwrites the saved refresh_token.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const brandId = req.nextUrl.searchParams.get('brandId');
  if (!brandId?.startsWith('brd_')) {
    return NextResponse.json({ error: 'brandId is required' }, { status: 400 });
  }
  // Optional: pre-fill the Google account chooser with this email. Useful
  // when the operator knows which Google account owns the YouTube channel
  // and wants to skip scrolling through the chooser.
  const loginHint = req.nextUrl.searchParams.get('login_hint') ?? undefined;
  const origin = req.nextUrl.origin;
  const redirectUri = `${origin}/api/youtube/oauth/callback`;
  try {
    const url = youtubeAuthUrl(brandId, redirectUri, loginHint);
    return NextResponse.redirect(url);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }
}
