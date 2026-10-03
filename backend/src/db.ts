import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

const { Pool } = pg;

const connectionString =
  process.env.DATABASE_URL || 'postgresql://skuzmak@localhost:5432/scoreboard';

// pg query logger — emits a line for every query with its duration.
// Useful for diagnosing slow DB writes from the GC poller.
// Set GC_QUERY_LOG=1 in the environment to enable.
const QUERY_LOG = process.env.GC_QUERY_LOG === '1';
const SLOW_QUERY_MS = 100;

export const pool = new Pool({ connectionString });

// Track pool stats so we can see connection starvation
let activeQueries = 0;
let totalQueries = 0;
let slowQueries = 0;
let maxConcurrent = 0;

export function getPoolStats() {
  return {
    activeQueries,
    totalQueries,
    slowQueries,
    maxConcurrent,
    poolTotal: pool.totalCount,
    poolIdle: pool.idleCount,
    poolWaiting: pool.waitingCount,
  };
}

export async function query<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const start = Date.now();
  activeQueries++;
  totalQueries++;
  if (activeQueries > maxConcurrent) maxConcurrent = activeQueries;
  try {
    const result = await pool.query(text, params as pg.QueryConfig['values']);
    const duration = Date.now() - start;
    if (duration > SLOW_QUERY_MS) {
      slowQueries++;
      console.warn(`[db] SLOW ${duration}ms ${text.slice(0, 80).replace(/\s+/g, ' ')}${QUERY_LOG ? `\n  full: ${text}` : ''}`);
    } else if (QUERY_LOG) {
      console.log(`[db] ${duration}ms ${text.slice(0, 80).replace(/\s+/g, ' ')}`);
    }
    return result.rows as unknown as T[];
  } finally {
    activeQueries--;
  }
}

export async function queryOne<T = Record<string, unknown>>(
  text: string,
  params: unknown[] = []
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows.length > 0 ? rows[0] : null;
}
