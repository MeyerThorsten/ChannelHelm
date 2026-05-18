import { makeId } from '@/lib/ids';
import { sql } from 'drizzle-orm';
import { index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { brands } from './brands';
import { sources } from './sources';

export const packages = pgTable(
  'packages',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => makeId('pkg')),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id),
    status: text('status').notNull().default('draft'),
    processingProfile: text('processing_profile').notNull().default('standard_audio_visual'),
    intelligence: jsonb('intelligence')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    routing: jsonb('routing').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedBy: text('approved_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_packages_brand_status').on(t.brandId, t.status),
    index('idx_packages_source').on(t.sourceId),
    index('idx_packages_updated').on(t.updatedAt.desc()),
  ],
);
