// Shared voice-bootstrap types + the seedable asset-type list. Kept OUT of the
// `'use server'` action file (src/server-actions/voice-bootstrap.ts), which may
// only export async functions — a const/type export there throws at runtime.

/** Asset types generate_asset produces text content for (the seedable types). */
export const GENERATABLE_TEXT_TYPES = [
  'youtube_title_set',
  'youtube_description',
  'linkedin_post',
  'x_post',
  'x_thread',
  'article_brief',
  'newsletter_summary',
  'facebook_post',
  'threads_post',
  'bluesky_post',
  'reddit_post',
  'pinterest_pin',
  'telegram_post',
  'discord_message',
  'google_business_post',
  'youtube_pinned_comment',
] as const;

export type GeneratableTextType = (typeof GENERATABLE_TEXT_TYPES)[number];

export type VoiceCountRow = {
  assetType: string;
  count: number;
};
