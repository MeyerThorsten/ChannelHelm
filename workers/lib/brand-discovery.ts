import { randomBytes } from 'node:crypto';
import { db } from '@/db/client';
import { brands } from '@/db/schema';
import { registrableDomain, slugify } from '@/lib/url';
import { fetchMetadata } from '@workers/integrations/ytdlp';
import { eq, sql } from 'drizzle-orm';

export type DiscoveredBrand = {
  brandId: string;
  created: boolean;
  matchedBy: 'youtube_channel' | 'website' | 'created' | 'fallback';
  channelName: string | null;
  website: string | null;
};

/**
 * Discover (and if needed create) the brand a YouTube URL belongs to.
 *
 * Order: youtube_channel_id → website domain → create new. Website is found
 * best-effort by scraping the channel's About page, optionally enriched via
 * the YouTube Data API when YOUTUBE_API_KEY is set. Channel discovery itself
 * (id/name) is robust via yt-dlp.
 *
 * `fallbackBrandId` is used only if yt-dlp can't read the channel at all
 * (private/blocked video) — we don't want to block ingest on discovery.
 */
export async function discoverBrandForYoutube(
  url: string,
  fallbackBrandId?: string,
): Promise<DiscoveredBrand> {
  let meta: Awaited<ReturnType<typeof fetchMetadata>>;
  try {
    meta = await fetchMetadata(url);
  } catch (err) {
    console.warn('[brand-discovery] yt-dlp metadata failed:', err);
    if (fallbackBrandId) {
      return {
        brandId: fallbackBrandId,
        created: false,
        matchedBy: 'fallback',
        channelName: null,
        website: null,
      };
    }
    throw new Error('Could not read the YouTube channel for this URL, and no fallback brand.');
  }

  // 1. Match by channel id.
  if (meta.channelId) {
    const [byChannel] = await db
      .select()
      .from(brands)
      .where(eq(brands.youtubeChannelId, meta.channelId))
      .limit(1);
    if (byChannel) {
      return {
        brandId: byChannel.id,
        created: false,
        matchedBy: 'youtube_channel',
        channelName: meta.channelName,
        website: byChannel.website,
      };
    }
  }

  // 2. Discover the website (best-effort) and match by domain.
  const website = await discoverChannelWebsite(meta.channelId, meta.handle);
  if (website) {
    const domain = registrableDomain(website);
    if (domain) {
      const candidates = await db.select().from(brands);
      const match = candidates.find((b) => registrableDomain(b.website) === domain);
      if (match) {
        // Backfill the channel id so next time it matches directly.
        if (meta.channelId && !match.youtubeChannelId) {
          await db
            .update(brands)
            .set({ youtubeChannelId: meta.channelId, updatedAt: sql`now()` })
            .where(eq(brands.id, match.id));
        }
        return {
          brandId: match.id,
          created: false,
          matchedBy: 'website',
          channelName: meta.channelName,
          website,
        };
      }
    }
  }

  // 3. Create a new brand from the channel.
  const name = meta.channelName ?? meta.handle ?? 'New brand';
  const brandId = `brd_${Date.now().toString(36)}${randomBytes(6).toString('hex')}`;
  const slug = await uniqueSlug(slugify(meta.handle?.replace(/^@/, '') ?? name));
  await db.insert(brands).values({
    id: brandId,
    slug,
    name,
    youtubeChannelId: meta.channelId,
    website,
  });
  return { brandId, created: true, matchedBy: 'created', channelName: name, website };
}

async function uniqueSlug(base: string): Promise<string> {
  let slug = base;
  for (let i = 0; i < 50; i++) {
    const [existing] = await db
      .select({ id: brands.id })
      .from(brands)
      .where(eq(brands.slug, slug))
      .limit(1);
    if (!existing) return slug;
    slug = `${base}-${i + 2}`;
  }
  return `${base}-${randomBytes(3).toString('hex')}`;
}

/**
 * Best-effort channel website discovery. Prefers the YouTube Data API
 * (when a key is set) for the channel's metadata, and scrapes the public
 * About page for the external website link. Returns the first plausible
 * non-YouTube/non-social URL, or null.
 */
export async function discoverChannelWebsite(
  channelId: string | null,
  handle: string | null,
): Promise<string | null> {
  // The Data API doesn't reliably expose external links, but we still try it
  // first when configured — some channels surface a site in the description.
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (apiKey && channelId) {
    try {
      const res = await fetch(
        `https://www.googleapis.com/youtube/v3/channels?part=snippet,brandingSettings&id=${channelId}&key=${apiKey}`,
      );
      if (res.ok) {
        const data = (await res.json()) as {
          items?: { snippet?: { description?: string } }[];
        };
        const desc = data.items?.[0]?.snippet?.description ?? '';
        const fromDesc = firstExternalUrl(desc.match(/https?:\/\/[^\s)]+/g) ?? []);
        if (fromDesc) return fromDesc;
      }
    } catch (err) {
      console.warn('[brand-discovery] YouTube Data API failed:', err);
    }
  }

  // Scrape the About page. YouTube embeds external links as
  // /redirect?...&q=<encoded target>.
  const aboutUrl = handle
    ? `https://www.youtube.com/${handle}/about`
    : channelId
      ? `https://www.youtube.com/channel/${channelId}/about`
      : null;
  if (!aboutUrl) return null;
  try {
    const res = await fetch(aboutUrl, {
      headers: { 'accept-language': 'en-US,en;q=0.9', 'user-agent': 'Mozilla/5.0 ChannelHelm' },
    });
    if (!res.ok) return null;
    const html = await res.text();
    // Only trust YouTube's external-link wrapper (`/redirect?...&q=<target>`).
    // A raw scan of the page HTML is too noisy — it picks up asset CDNs like
    // i.ytimg.com. A channel with no external website yields null (correct).
    const redirects = [...html.matchAll(/[?&]q=([^"&\\]+)/g)]
      .map((m) => safeDecode(m[1]))
      .filter((u): u is string => !!u && /^https?:\/\//i.test(u));
    return firstExternalUrl(redirects);
  } catch (err) {
    console.warn('[brand-discovery] About-page scrape failed:', err);
    return null;
  }
}

const SOCIAL_HOSTS = [
  'youtube.com',
  'youtu.be',
  'ytimg.com',
  'ggpht.com',
  'googlevideo.com',
  'googleapis.com',
  'googletagmanager.com',
  'doubleclick.net',
  'schema.org',
  'w3.org',
  'google.com',
  'gstatic.com',
  'instagram.com',
  'twitter.com',
  'x.com',
  'facebook.com',
  'tiktok.com',
  'linkedin.com',
  'threads.net',
  'discord.gg',
  'discord.com',
  't.me',
  'patreon.com',
  'twitch.tv',
];

function firstExternalUrl(urls: string[]): string | null {
  for (const u of urls) {
    const domain = registrableDomain(u);
    if (!domain) continue;
    if (SOCIAL_HOSTS.some((h) => domain === h || domain.endsWith(`.${h}`))) continue;
    return `https://${domain}`;
  }
  return null;
}

function safeDecode(s: string | undefined): string | null {
  if (!s) return null;
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
