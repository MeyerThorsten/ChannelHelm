import { bigserial, boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { assets } from './assets';

export const dispatches = pgTable(
  'dispatches',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    assetId: text('asset_id')
      .notNull()
      .references(() => assets.id),
    target: text('target').notNull(),
    requestPayload: jsonb('request_payload').$type<Record<string, unknown>>().notNull(),
    responsePayload: jsonb('response_payload').$type<Record<string, unknown>>(),
    externalId: text('external_id'),
    success: boolean('success'),
    error: text('error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_dispatches_asset').on(t.assetId),
    index('idx_dispatches_target_success').on(t.target, t.success),
  ],
);
