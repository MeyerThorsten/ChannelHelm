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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('idx_brands_active').on(t.active).where(sql`${t.active} = TRUE`)],
);
