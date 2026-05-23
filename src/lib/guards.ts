// Cost/abuse guards for the public analyze endpoint. Each analysis spends real
// money, so beyond the SSRF guard (github.ts) and SHA-dedupe cache (analyses.ts)
// we add: a per-client daily request cap and a global daily $ ceiling. Both are
// dependency-injectable for tests and reset at UTC midnight.

import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import { db } from '../db/client';

type Conn = Pick<Client, 'execute'>;

export const DEFAULT_DAILY_CAP = 5; // analyses per client per UTC day
export const DEFAULT_GLOBAL_DAILY_USD = 5; // global spend ceiling per UTC day

function utcDay(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

// A stable, salted, truncated hash of the client IP (or a UA+lang fingerprint
// when no forwarded IP is present). We never store the raw IP.
export function clientKey(headers: Headers): string {
  const salt = process.env.RATE_LIMIT_SALT ?? '';
  const xff = headers.get('x-forwarded-for');
  const ip = xff ? (xff.split(',')[0]?.trim() ?? '') : '';
  if (ip) return 'ip:' + createHash('sha256').update(salt + ip).digest('hex').slice(0, 16);
  const ua = headers.get('user-agent') ?? '';
  const lang = headers.get('accept-language') ?? '';
  return 'fp:' + createHash('sha256').update(`${salt}${ua}\n${lang}`).digest('hex').slice(0, 16);
}

export type DailyCapResult = { allowed: boolean; count: number; limit: number };

/** Atomic per-client daily cap. Single statement closes the read-modify-write race. */
export async function checkDailyCap(
  key: string,
  limit = DEFAULT_DAILY_CAP,
  opts: { now?: () => number; client?: Conn } = {}
): Promise<DailyCapResult> {
  const now = opts.now ?? Date.now;
  const c = opts.client ?? db();
  const day = utcDay(now());
  // INSERT seeds count=1; the conflict branch increments only while under the cap
  // (the WHERE gates it). No row returned ⇒ the cap was already reached.
  const res = await c.execute({
    sql: `INSERT INTO request_counts (bucket, day, count) VALUES (:key, :day, 1)
          ON CONFLICT (bucket, day) DO UPDATE SET count = count + 1 WHERE count < :limit
          RETURNING count`,
    args: { key, day, limit },
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (row) return { allowed: true, count: Number(row.count), limit };
  const cur = await c.execute({
    sql: 'SELECT count FROM request_counts WHERE bucket = ? AND day = ?',
    args: [key, day],
  });
  const curRow = cur.rows[0] as Record<string, unknown> | undefined;
  return { allowed: false, count: curRow ? Number(curRow.count) : limit, limit };
}

export type BudgetResult = { allowed: boolean; spentMicroUsd: number; ceilingMicroUsd: number };

/** Global daily spend ceiling — sum of today's analysis cost across all clients. */
export async function checkGlobalDailyBudget(
  ceilingUsd = DEFAULT_GLOBAL_DAILY_USD,
  opts: { now?: () => number; client?: Conn } = {}
): Promise<BudgetResult> {
  const now = opts.now ?? Date.now;
  const c = opts.client ?? db();
  const startOfDay = Date.parse(`${utcDay(now())}T00:00:00Z`);
  const res = await c.execute({
    sql: 'SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM analyses WHERE created_at >= ?',
    args: [startOfDay],
  });
  const spentMicroUsd = Number((res.rows[0] as Record<string, unknown>).total);
  const ceilingMicroUsd = Math.round(ceilingUsd * 1_000_000);
  return { allowed: spentMicroUsd < ceilingMicroUsd, spentMicroUsd, ceilingMicroUsd };
}
