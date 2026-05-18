import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

// Idempotency-key conventions (enqueuers MUST set these where the kind appears
// in the contract §4 schema comments):
//   ingest               → 'ingest:{source_id}'
//   transcribe_audio     → 'transcribe_audio:{source_id}'
//   analyze_visual       → 'analyze_visual:{source_id}:{profile}'
//   fuse                 → 'fuse:{source_id}:{profile}'
//   analyze_intelligence → 'analyze_intelligence:{source_id}:{profile}'
//   generate_asset       → 'generate_asset:{package_id}:{asset_type}'
//   clip_render          → 'clip_render:{plan_asset_id}:{clip_index}'
//   dispatch             → 'dispatch:{asset_id}'
//   collect_signal       → 'collect_signal:{asset_id}:{window_start_iso}'
export const jobs = pgTable(
  'jobs',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    kind: text('kind').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull().default('pending'),
    priority: integer('priority').notNull().default(5),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(3),
    lockedBy: text('locked_by'),
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    runAfter: timestamp('run_after', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('idx_jobs_kind_idempotency')
      .on(t.kind, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} IS NOT NULL`),
    index('idx_jobs_claim')
      .on(t.status, t.priority, t.runAfter)
      .where(sql`${t.status} = 'pending'`),
    index('idx_jobs_kind_status').on(t.kind, t.status),
  ],
);
