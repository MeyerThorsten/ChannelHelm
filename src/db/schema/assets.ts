import { makeId } from '@/lib/ids';
import { sql } from 'drizzle-orm';
import { boolean, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { brands } from './brands';
import { packages } from './packages';

export const assets = pgTable(
  'assets',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => makeId('ast')),
    packageId: text('package_id')
      .notNull()
      .references(() => packages.id, { onDelete: 'cascade' }),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id),
    type: text('type').notNull(),
    status: text('status').notNull().default('draft'),
    approvalRequired: boolean('approval_required').notNull().default(true),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    provenance: jsonb('provenance')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    dispatch: jsonb('dispatch')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    signals: jsonb('signals').$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_assets_package').on(t.packageId),
    index('idx_assets_brand_type_status').on(t.brandId, t.type, t.status),
    index('idx_assets_dispatch_external')
      .on(sql`(${t.dispatch} ->> 'external_id')`)
      .where(sql`(${t.dispatch} ->> 'external_id') IS NOT NULL`),
  ],
);
