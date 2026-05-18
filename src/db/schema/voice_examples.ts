import {
  bigserial,
  doublePrecision,
  index,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { brands } from './brands';

export const voiceExamples = pgTable(
  'voice_examples',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id),
    assetType: text('asset_type').notNull(),
    text: text('text').notNull(),
    performanceScore: doublePrecision('performance_score'),
    usedAsExampleCount: integer('used_as_example_count').default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_voice_examples_brand_type_score').on(
      t.brandId,
      t.assetType,
      t.performanceScore.desc(),
    ),
  ],
);
