// Turso-backed token bucket for public, unauthenticated endpoints. Any route
// that fans out to a paid API needs this — without it a botnet trivially drains
// the budget. P0 abuse guard; see the zeroindex-foundation skill.
//
// Bucket: capacity 10 tokens, refill 10 tokens / 60s (≈ 0.1667 tokens/sec).
// Tune BUCKET_CAPACITY per endpoint cost. Keyed by client IP (x-forwarded-for)
// with a hashed UA + Accept-Language fallback for missing-header clients. State
// is persisted in `rate_limit_buckets` (created in src/db/migrations/0001_init.sql).

import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import { db } from '../db/client';

export const BUCKET_CAPACITY = 10;
export const BUCKET_REFILL_PER_SEC = BUCKET_CAPACITY / 60;

export type RateLimitDecision =
  | { allowed: true; remaining: number }
  | { allowed: false; retryAfterSec: number };

export type RateLimitOptions = {
  // Injected for tests; defaults call the module-level singletons.
  now?: () => number;
  client?: () => Pick<Client, 'execute'>;
  capacity?: number;
  refillPerSec?: number;
};

// Pull the first non-empty IP from a possibly comma-separated x-forwarded-for.
function firstForwardedIp(header: string | null): string | null {
  if (!header) return null;
  const first = header.split(',')[0]?.trim();
  return first ? first : null;
}

export function bucketKeyFromHeaders(headers: Headers): string {
  const ip = firstForwardedIp(headers.get('x-forwarded-for'));
  if (ip) return `ip:${ip}`;
  // Fall back to a stable hash of UA + Accept-Language so anonymous clients
  // without a forwarded IP still share a bucket per-fingerprint rather than
  // bypassing the limit entirely.
  const ua = headers.get('user-agent') ?? '';
  const lang = headers.get('accept-language') ?? '';
  const digest = createHash('sha256').update(`${ua}\n${lang}`).digest('hex').slice(0, 16);
  return `fp:${digest}`;
}

// Token-bucket math, isolated for unit testing without a DB.
export function computeNextState(
  currentTokens: number,
  lastUpdatedMs: number,
  nowMs: number,
  capacity: number,
  refillPerSec: number
): { tokens: number; allowed: boolean; retryAfterSec: number } {
  const elapsedSec = Math.max(0, (nowMs - lastUpdatedMs) / 1000);
  const refilled = Math.min(capacity, currentTokens + elapsedSec * refillPerSec);
  if (refilled >= 1) {
    return { tokens: refilled - 1, allowed: true, retryAfterSec: 0 };
  }
  const deficit = 1 - refilled;
  return {
    tokens: refilled,
    allowed: false,
    retryAfterSec: Math.max(1, Math.ceil(deficit / refillPerSec)),
  };
}

export async function checkRateLimit(key: string, opts: RateLimitOptions = {}): Promise<RateLimitDecision> {
  const now = opts.now ?? Date.now;
  const c = opts.client ?? db;
  const capacity = opts.capacity ?? BUCKET_CAPACITY;
  const refillPerSec = opts.refillPerSec ?? BUCKET_REFILL_PER_SEC;
  const conn = c();
  const nowMs = now();

  // Single atomic UPSERT — no read-modify-write window. The conflict branch
  // computes the time-based refill INLINE in SQL and decrements by 1 only when
  // the refilled value is >= 1 (guarded by the conflict-target WHERE clause).
  // RETURNING surfaces the resulting token count and whether a row was written,
  // so allow/deny is derived from one statement. This closes the prior TOCTOU
  // race: two concurrent same-key requests serialize on the row, so they can
  // never both consume the last token.
  //
  // The refilled value is recomputed identically to computeNextState():
  //   refilled = MIN(capacity, tokens + (now - updated_at)/1000 * refillPerSec)
  // The insert branch seeds a full bucket (capacity) then spends one token.
  const result = await conn.execute({
    sql: `
      INSERT INTO rate_limit_buckets (key, tokens, updated_at)
      VALUES (:key, :capacity - 1, :now)
      ON CONFLICT(key) DO UPDATE SET
        tokens = MIN(:capacity, tokens + (:now - updated_at) / 1000.0 * :refill) - 1,
        updated_at = :now
      WHERE MIN(:capacity, tokens + (:now - updated_at) / 1000.0 * :refill) >= 1
      RETURNING tokens
    `,
    args: { key, capacity, now: nowMs, refill: refillPerSec },
  });

  const row = result.rows[0];
  if (row && row.tokens !== null) {
    // A row was written (insert, or conditional update that passed the WHERE) —
    // the request consumed a token and is allowed.
    return { allowed: true, remaining: Math.max(0, Math.floor(Number(row.tokens))) };
  }

  // No row returned: the UPDATE's WHERE failed (refilled tokens < 1), so the
  // bucket is empty. Read the current state to compute an accurate retry-after.
  // (The denied path does no write, so it cannot itself drain the bucket.)
  const existing = await conn.execute({
    sql: 'SELECT tokens, updated_at FROM rate_limit_buckets WHERE key = ?',
    args: [key],
  });
  const stateRow = existing.rows[0];
  const currentTokens = stateRow && stateRow.tokens !== null ? Number(stateRow.tokens) : capacity;
  const lastUpdated = stateRow && stateRow.updated_at !== null ? Number(stateRow.updated_at) : nowMs;
  const next = computeNextState(currentTokens, lastUpdated, nowMs, capacity, refillPerSec);
  // next.allowed is false here by construction; surface its retry-after.
  return { allowed: false, retryAfterSec: next.retryAfterSec };
}
