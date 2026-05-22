/**
 * Thin job-queue layer over PostgreSQL using SELECT FOR UPDATE SKIP LOCKED.
 *
 * The four public functions — enqueue, claim, complete, fail — mirror the SQL
 * idiom in contract §6.1 verbatim. This is the ONLY module allowed to INSERT
 * into the `jobs` table; everything else must call `enqueue()`.
 *
 * Uses raw `pg` (no Drizzle) because the queue is the hot path and the SQL is
 * load-bearing — we want exact control over the prepared statements.
 */
import 'dotenv/config';
import pg, { Pool, type PoolClient } from 'pg';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set');
}

// Parse BIGINT (int8 = pg type OID 20) as JS number rather than string. All
// BIGSERIAL ids in this codebase are well under 2^53 so this is safe; without
// it, raw `pg` returns string while Drizzle's `mode: 'number'` returns number,
// which would leave job.id typed as number but actually a string at runtime.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export type JobRow = {
  id: number;
  kind: string;
  payload: Record<string, unknown>;
  status: 'pending' | 'running' | 'done' | 'failed';
  priority: number;
  attempts: number;
  max_attempts: number;
  locked_by: string | null;
  locked_at: Date | null;
  run_after: Date;
  last_error: string | null;
  idempotency_key: string | null;
  created_at: Date;
  updated_at: Date;
};

export type EnqueueResult = {
  id: number;
  created: boolean; // false when an existing row with the same idempotency key was returned
};

/**
 * Insert a job. If `idempotencyKey` is provided and a live or completed job
 * already exists for `(kind, idempotency_key)`, return the existing row's id
 * and `created: false` instead of inserting a duplicate.
 */
export async function enqueue(opts: {
  kind: string;
  payload: Record<string, unknown>;
  idempotencyKey?: string;
  priority?: number;
  runAfter?: Date;
}): Promise<EnqueueResult> {
  const { kind, payload, idempotencyKey = null, priority = 5, runAfter } = opts;
  const client = await pool.connect();
  try {
    const insertSql = `
      INSERT INTO jobs (kind, payload, priority, idempotency_key, run_after)
      VALUES ($1, $2::jsonb, $3, $4, COALESCE($5, now()))
      ON CONFLICT (kind, idempotency_key) WHERE idempotency_key IS NOT NULL
      DO NOTHING
      RETURNING id`;
    const inserted = await client.query<{ id: number }>(insertSql, [
      kind,
      JSON.stringify(payload),
      priority,
      idempotencyKey,
      runAfter ?? null,
    ]);
    if (inserted.rows[0]) return { id: inserted.rows[0].id, created: true };

    // ON CONFLICT swallowed the INSERT — fetch the existing id.
    const existing = await client.query<{ id: number }>(
      'SELECT id FROM jobs WHERE kind = $1 AND idempotency_key = $2 LIMIT 1',
      [kind, idempotencyKey],
    );
    const row = existing.rows[0];
    if (!row)
      throw new Error(`enqueue: conflict but no existing row for (${kind}, ${idempotencyKey})`);
    return { id: row.id, created: false };
  } finally {
    client.release();
  }
}

/**
 * Claim one pending job whose kind is in `workerKinds`. Marks it running,
 * increments attempts, and returns the full row. Returns null when nothing
 * is claimable. SQL is §6.1 verbatim, with the §6.3 worker-kind filter.
 */
export async function claim(workerKinds: string[], lockedBy: string): Promise<JobRow | null> {
  const result = await pool.query<JobRow>(
    `
    WITH next AS (
      SELECT id FROM jobs
      WHERE status = 'pending'
        AND run_after <= now()
        AND kind = ANY($1::text[])
      ORDER BY priority ASC, id ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE jobs
       SET status = 'running',
           locked_by = $2,
           locked_at = now(),
           attempts = attempts + 1,
           updated_at = now()
      FROM next
     WHERE jobs.id = next.id
    RETURNING jobs.*`,
    [workerKinds, lockedBy],
  );
  return result.rows[0] ?? null;
}

export async function complete(jobId: number): Promise<void> {
  await pool.query(
    `UPDATE jobs SET status = 'done', locked_by = NULL, locked_at = NULL, updated_at = now() WHERE id = $1`,
    [jobId],
  );
}

/**
 * Record a failure. If attempts < max_attempts, requeue with exponential
 * backoff (`run_after = now() + 1 minute × 2^attempts`) per §6.4. Otherwise
 * leave at status = 'failed' for manual triage.
 *
 * Test escape hatch: when `WORKER_NO_BACKOFF=1`, retries become eligible
 * immediately (run_after = now()) instead of waiting out the exponential
 * window. Smoke scripts set this so a single flaky LLM JSON response
 * doesn't stall the suite for 2+ minutes. Production must NOT set it —
 * the backoff is what keeps the queue from hot-looping on a failing job.
 */
export async function fail(jobId: number, error: string): Promise<void> {
  const noBackoff = process.env.WORKER_NO_BACKOFF === '1';
  await pool.query(
    `
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           last_error = $2,
           run_after = CASE
             WHEN attempts >= max_attempts THEN run_after
             WHEN $3::boolean THEN now()
             ELSE now() + (interval '1 minute') * (2 ^ attempts)
           END,
           locked_by = NULL,
           locked_at = NULL,
           updated_at = now()
     WHERE id = $1`,
    [jobId, error, noBackoff],
  );
}

/**
 * §7: reclaim jobs stuck in `running` after a worker crash / SIGKILL / sleep —
 * the live process never reached complete()/fail(). A job whose `locked_at`
 * is older than its kind's lock timeout is requeued (or moved to `failed`
 * once attempts are exhausted) so the pipeline can make progress again.
 *
 * Idempotency keys + the dispatch worker's pre-call check on existing
 * `dispatch.external_id` keep recovered jobs from duplicating completed work.
 * Timeouts are generous for the heavy ML/render kinds.
 */
const LOCK_TIMEOUT_SQL = `CASE kind
  WHEN 'transcribe_audio'     THEN interval '45 minutes'
  WHEN 'analyze_visual'       THEN interval '120 minutes'
  WHEN 'clip_render'          THEN interval '60 minutes'
  WHEN 'ingest'               THEN interval '30 minutes'
  WHEN 'fuse'                 THEN interval '15 minutes'
  WHEN 'analyze_intelligence' THEN interval '20 minutes'
  WHEN 'generate_asset'       THEN interval '20 minutes'
  ELSE interval '15 minutes'
END`;

export async function reclaimStaleJobs(
  workerKinds: string[],
): Promise<{ id: number; kind: string }[]> {
  const result = await pool.query<{ id: number; kind: string }>(
    `
    UPDATE jobs
       SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
           last_error = COALESCE(last_error, 'reclaimed: worker lock expired'),
           locked_by = NULL,
           locked_at = NULL,
           updated_at = now()
     WHERE status = 'running'
       AND kind = ANY($1::text[])
       AND locked_at IS NOT NULL
       AND locked_at < now() - (${LOCK_TIMEOUT_SQL})
    RETURNING id, kind`,
    [workerKinds],
  );
  return result.rows;
}

/**
 * Signal from a handler that the job should be deferred (not completed, not
 * failed) until `runAfter`. The runner catches this and calls requeueAt().
 * Used by dispatch for §9.6 rate-limit backoff to the next UTC day.
 */
export class RequeueLater extends Error {
  constructor(
    public readonly runAfter: Date,
    message: string,
  ) {
    super(message);
    this.name = 'RequeueLater';
  }
}

/** Return a job to `pending` with an explicit future `run_after`, releasing its lock. */
export async function requeueAt(jobId: number, runAfter: Date): Promise<void> {
  await pool.query(
    `UPDATE jobs
        SET status = 'pending', run_after = $2, locked_by = NULL, locked_at = NULL, updated_at = now()
      WHERE id = $1`,
    [jobId, runAfter],
  );
}

export async function shutdown(): Promise<void> {
  await pool.end();
}

// Test helper. NOT for production code paths.
export async function _withClient<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
}
