import { sql } from 'drizzle-orm';
import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    source: text('source').notNull(),
    sourceEventId: text('source_event_id').notNull(),
    eventType: text('event_type').notNull(),
    externalId: text('external_id'),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    processed: boolean('processed').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('idx_webhook_source_event').on(t.source, t.sourceEventId),
    index('idx_webhook_unprocessed').on(t.source, t.receivedAt).where(sql`${t.processed} = FALSE`),
  ],
);
