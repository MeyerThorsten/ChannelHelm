import 'dotenv/config';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg, { Pool } from 'pg';
import * as schema from './schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

// Parse BIGINT (int8) as JS number — see comment in workers/queue.ts. This
// keeps `jobs.id` consistently typed across the Drizzle and raw `pg` paths.
pg.types.setTypeParser(20, (v) => Number.parseInt(v, 10));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 10,
});

export const db = drizzle(pool, { schema });

export type Database = typeof db;
