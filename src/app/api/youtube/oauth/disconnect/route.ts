import { youtubeOauthDisconnect } from '@workers/integrations/youtube';
import { type NextRequest, NextResponse } from 'next/server';

/**
 * POST /api/youtube/oauth/disconnect?brandId=brd_…
 *
 * Clears the saved refresh_token and resets `youtube_dispatch_target` to
 * 'manual' so a subsequent dispatch can't surprise-upload via stale tokens.
 * The Google-side grant is still revocable at myaccount.google.com.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const brandId = req.nextUrl.searchParams.get('brandId');
  if (!brandId?.startsWith('brd_')) {
    return NextResponse.json({ error: 'brandId is required' }, { status: 400 });
  }
  try {
    await youtubeOauthDisconnect(brandId);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
