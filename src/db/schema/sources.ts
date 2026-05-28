import { makeId } from '@/lib/ids';
import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp, unique } from 'drizzle-orm/pg-core';
import { brands } from './brands';

export const sources = pgTable(
  'sources',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => makeId('src')),
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id),
    kind: text('kind').notNull(),
    originUrl: text('origin_url'),
    localMediaPath: text('local_media_path'),
    // Storage lifecycle (Option B): set when archive_package moves a
    // source's media off MEDIA_ROOT. Lives alongside `local_media_path`
    // because the archive directory layout mirrors the source layout
    // exactly (original.mp4 + clips/ at the root). When archived,
    // `local_media_path` still points at the original directory (now
    // empty/missing) and clip_render falls back to `archive_path` for
    // re-renders. Null = never archived.
    archivePath: text('archive_path'),
    durationSeconds: integer('duration_seconds'),
    language: text('language'),
    title: text('title'),
    metadata: jsonb('metadata')
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_sources_brand').on(t.brandId),
    index('idx_sources_kind').on(t.kind),
    // §3 / #1: lets packages reference (source_id, brand_id) as a composite FK
    // so a package can't disagree with its source's brand at the DB level.
    unique('uq_sources_id_brand').on(t.id, t.brandId),
  ],
);
