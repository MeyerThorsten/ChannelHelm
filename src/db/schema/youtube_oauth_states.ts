import { index, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { brands } from './brands';

export const youtubeOauthStates = pgTable(
  'youtube_oauth_states',
  {
    state: text('state').primaryKey(),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id, { onDelete: 'cascade' }),
    redirectUri: text('redirect_uri').notNull(),
    loginHint: text('login_hint'),
    expectedChannelId: text('expected_channel_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
  },
  (t) => [
    index('idx_youtube_oauth_states_brand').on(t.brandId),
    index('idx_youtube_oauth_states_expires').on(t.expiresAt),
  ],
);
