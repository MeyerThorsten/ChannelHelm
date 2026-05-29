/**
 * One-off ops: change a YouTube video's visibility for a brand.
 *
 *   pnpm tsx scripts/set-video-privacy.ts \
 *     --brand brd_xxx --video VIDEO_ID --privacy public
 *
 * Reuses the brand's stored OAuth refresh_token (workers/integrations/youtube.ts).
 * The redirectUri only needs to construct the OAuth client; the refresh-token
 * flow doesn't require it to match the original, so we use the same callback the
 * workers build from CLOUDFLARE_TUNNEL_HOSTNAME.
 */
import 'dotenv/config';
import { loadSettingsIntoEnv } from '@/lib/settings';
import { setVideoPrivacy } from '../workers/integrations/youtube';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const brandId = arg('brand');
  const videoId = arg('video');
  const privacy = (arg('privacy') ?? 'public') as 'private' | 'unlisted' | 'public';
  if (!brandId || !videoId) {
    console.error('usage: --brand <brd_…> --video <videoId> [--privacy public|unlisted|private]');
    process.exit(2);
  }
  // GOOGLE_OAUTH_* + secrets live in the DB settings table, hydrated at worker
  // boot. A standalone script must hydrate them too before touching the client.
  await loadSettingsIntoEnv();
  const redirectUri = `${process.env.CLOUDFLARE_TUNNEL_HOSTNAME ?? 'http://localhost:3000'}/api/youtube/oauth/callback`;
  const res = await setVideoPrivacy({ brandId, redirectUri, videoId, privacyStatus: privacy });
  console.log(`✓ video ${res.videoId} → privacy=${res.privacy}  (https://youtu.be/${res.videoId})`);
  process.exit(0);
}

main().catch((err) => {
  console.error('✗', err instanceof Error ? err.message : err);
  process.exit(1);
});
