import { makeId } from '@/lib/ids';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export const brands = pgTable(
  'brands',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => makeId('brd')),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    voiceProfile: jsonb('voice_profile')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    zernioProfileId: text('zernio_profile_id'),
    // Per-platform Zernio/LATE account ids: { x: "acc_…", linkedin: "acc_…", … }.
    // Required by the §9.3 posts.create request (platforms[].accountId).
    zernioAccounts: jsonb('zernio_accounts')
      .$type<Record<string, string>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    dojoclawSites: jsonb('dojoclaw_sites').$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    youtubeChannelId: text('youtube_channel_id'),
    // The brand's primary website (e.g. thorstenmeyerai.com). Used as a
    // secondary key when auto-discovering a brand from a YouTube channel.
    website: text('website'),
    defaultPublishingSchedule: text('default_publishing_schedule').notNull().default('balanced'),
    defaultProcessingProfile: text('default_processing_profile')
      .notNull()
      .default('standard_audio_visual'),
    approvalRequiredFor: jsonb('approval_required_for')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    autoDispatchFor: jsonb('auto_dispatch_for')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    // YouTube Data API v3 OAuth connection. refresh_token is AES-256-GCM
    // encrypted via secret-box (same as llm_providers.api_key). Empty/null
    // until the operator runs the OAuth flow at /api/youtube/oauth/start.
    youtubeOauth: jsonb('youtube_oauth').$type<{
      refresh_token: string; // encrypted
      access_token?: string; // encrypted; cached, may be expired
      access_token_expires_at?: string; // ISO
      channel_id?: string;
      channel_title?: string;
      scope: string;
      connected_at: string; // ISO
    } | null>(),
    // Routing for YouTube long-form dispatch:
    //   manual         → operator pastes the URL (default; safe)
    //   youtube_direct → dispatch worker uploads via YouTube Data API v3
    //   zernio         → dispatch worker hands off to Zernio (requires
    //                    public media URL — only when CF tunnel is up)
    youtubeDispatchTarget: text('youtube_dispatch_target').notNull().default('manual'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_brands_active').on(t.active).where(sql`${t.active} = TRUE`)],
);
