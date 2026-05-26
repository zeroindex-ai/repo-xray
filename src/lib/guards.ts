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
  if (ip)
    return (
      'ip:' +
      createHash('sha256')
        .update(salt + ip)
        .digest('hex')
        .slice(0, 16)
    );
  const ua = headers.get('user-agent') ?? '';
  const lang = headers.get('accept-language') ?? '';
  return 'fp:' + createHash('sha256').update(`${salt}${ua}\n${lang}`).digest('hex').slice(0, 16);
}

export type DailyCapResult = { allowed: boolean; count: number; limit: number };

/** Atomic per-client daily cap. Single statement closes the read-modify-write race. */
export async function checkDailyCap(
  key: string,
  limit = Number(process.env.ANALYZE_DAILY_CAP) || DEFAULT_DAILY_CAP,
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

// A run's estimated cost, reserved up-front so concurrent runs can't each pass a
// stale "still under budget" read and collectively overshoot. ~$0.40/run is the
// observed first-pass cost; reconciled to the real spend after the run.
export const RESERVATION_MICRO_USD = Number(process.env.ANALYZE_RESERVATION_MICRO_USD) || 400_000;

/**
 * Cheap, non-reserving budget read — sum of today's analysis cost across all
 * clients vs. the ceiling. Used as a fast fail-fast before the SSE stream opens
 * (so a clearly over-budget request still gets a real 503). It is NOT the
 * authoritative gate under concurrency — reserveGlobalDailyBudget is. See §3.
 */
export async function checkGlobalDailyBudget(
  ceilingUsd = Number(process.env.GLOBAL_DAILY_USD_CEILING) || DEFAULT_GLOBAL_DAILY_USD,
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

/**
 * Atomic budget *reservation* — the authoritative global-ceiling gate. Closes the
 * check-then-spend TOCTOU: a single UPDATE writes this run's estimated cost onto
 * its own `analyses` row, but only if today's total spend across *every other*
 * row plus the estimate still fits under the ceiling. The guard lives in the
 * WHERE clause, so N concurrent runs serialize on the row write and can't all
 * pass a stale "under budget" read — mirroring the rate limiter's guarded UPSERT.
 *
 * `cost_micro_usd` is part of the daily SUM, so a successful reservation is
 * immediately visible to every other run's check. After the run, the orchestrator
 * reconciles the placeholder down to the real spend with analyses.setCost.
 * RETURNING is empty ⇒ the reservation was denied.
 */
export async function reserveGlobalDailyBudget(
  analysisId: string,
  estimateMicroUsd = RESERVATION_MICRO_USD,
  ceilingUsd = Number(process.env.GLOBAL_DAILY_USD_CEILING) || DEFAULT_GLOBAL_DAILY_USD,
  opts: { now?: () => number; client?: Conn } = {}
): Promise<BudgetResult> {
  const now = opts.now ?? Date.now;
  const c = opts.client ?? db();
  const startOfDay = Date.parse(`${utcDay(now())}T00:00:00Z`);
  const ceilingMicroUsd = Math.round(ceilingUsd * 1_000_000);
  const estimate = Math.round(estimateMicroUsd);

  // Reserve only if (today's spend on all OTHER rows) + this estimate < ceiling.
  const res = await c.execute({
    sql: `UPDATE analyses
          SET cost_micro_usd = :estimate, updated_at = unixepoch() * 1000
          WHERE id = :id
            AND (
              (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM analyses
                 WHERE created_at >= :startOfDay AND id <> :id) + :estimate < :ceiling
            )
          RETURNING (SELECT COALESCE(SUM(cost_micro_usd), 0) FROM analyses WHERE created_at >= :startOfDay) AS total`,
    args: { id: analysisId, estimate, startOfDay, ceiling: ceilingMicroUsd },
  });
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (row) return { allowed: true, spentMicroUsd: Number(row.total), ceilingMicroUsd };

  // Denied: report the current total (reservation not written).
  const cur = await c.execute({
    sql: 'SELECT COALESCE(SUM(cost_micro_usd), 0) AS total FROM analyses WHERE created_at >= ?',
    args: [startOfDay],
  });
  return {
    allowed: false,
    spentMicroUsd: Number((cur.rows[0] as Record<string, unknown>).total),
    ceilingMicroUsd,
  };
}
