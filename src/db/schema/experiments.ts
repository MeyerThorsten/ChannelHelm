import { sql } from 'drizzle-orm';
import { index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { brands } from './brands';
import { packages } from './packages';

/**
 * Title/thumbnail A/B experiments (v1.5 — Helm Signal). Self-run rotation:
 * the `experiment_tick` worker applies one variant at a time to a PUBLISHED
 * YouTube video (title via videos.update, thumbnail via thumbnails.set), lets
 * it run for `rotation_hours`, then reads the variant's performance from the
 * YouTube Analytics API and stores it as an observation. After `rounds` full
 * rotations (and once every variant clears `min_views`), the winner is the
 * variant with the best `metric`; it's applied permanently and fed back into
 * `voice_examples` (winner positive, losers negative).
 *
 * Native YouTube "Test & Compare" is NOT in the Data API, hence self-run.
 */
export type ExperimentObservation = {
  cycle: number; // which rotation round this observation belongs to
  started_at: string; // ISO — when this variant went live this cycle
  ended_at: string; // ISO — when the window closed and analytics were read
  days: number; // Analytics query window length (whole days)
  views: number;
  estimated_minutes_watched: number | null;
  average_view_percentage: number | null;
  impressions: number | null; // null when the Analytics API doesn't return it
  impression_ctr: number | null; // 0..1, null when unavailable
};

export type ExperimentVariant = {
  variant_index: number;
  label: string; // "A", "B", …
  title?: string | null; // candidate title; null = leave the title unchanged
  title_asset_id?: string | null; // youtube_title_set asset for provenance
  title_option_index?: number | null; // which scored option within that asset
  thumbnail_asset_id?: string | null; // thumbnail_concept asset for provenance
  thumbnail_path?: string | null; // local image applied via thumbnails.set
  observations: ExperimentObservation[];
};

export const experiments = pgTable(
  'experiments',
  {
    id: text('id').primaryKey(), // exp_<ulid>
    brandId: text('brand_id')
      .notNull()
      .references(() => brands.id),
    packageId: text('package_id')
      .notNull()
      .references(() => packages.id),
    videoId: text('video_id').notNull(), // published YouTube video id (rotation target)
    kind: text('kind').notNull(), // 'title' | 'thumbnail' | 'title_thumbnail'
    status: text('status').notNull().default('draft'), // draft | running | decided | cancelled | error
    metric: text('metric').notNull().default('views'), // views | impression_ctr | estimated_minutes_watched
    variants: jsonb('variants').$type<ExperimentVariant[]>().notNull().default(sql`'[]'::jsonb`),
    rotationHours: integer('rotation_hours').notNull().default(48),
    minViews: integer('min_views').notNull().default(50), // each variant must clear this before deciding
    rounds: integer('rounds').notNull().default(1), // full rotations before deciding
    currentVariant: integer('current_variant'), // index currently applied to the video
    currentCycle: integer('current_cycle').notNull().default(0),
    currentVariantSince: timestamp('current_variant_since', { withTimezone: true }),
    winnerVariant: integer('winner_variant'),
    lastError: text('last_error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('idx_experiments_brand_status').on(t.brandId, t.status),
    index('idx_experiments_running').on(t.status).where(sql`${t.status} = 'running'`),
    index('idx_experiments_package').on(t.packageId),
  ],
);
