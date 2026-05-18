import { sql } from 'drizzle-orm';
import {
  bigserial,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { assets } from './assets';
import { brands } from './brands';

export const signals = pgTable(
  'signals',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id),
    assetId: text('asset_id').references(() => assets.id),
    sourceSignal: text('source_signal').notNull(),
    metric: text('metric').notNull(),
    value: doublePrecision('value').notNull(),
    sampledAt: timestamp('sampled_at', { withTimezone: true }).notNull(),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_signals_brand_asset').on(t.brandId, t.assetId),
    index('idx_signals_sampled').on(t.sampledAt.desc()),
  ],
);
