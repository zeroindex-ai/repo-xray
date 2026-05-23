import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCost, getOrCreateAnalysis } from '../db/analyses';
import { migrate } from '../db/migrate';
import { checkDailyCap, checkGlobalDailyBudget, clientKey } from './guards';

let db: Client;
beforeEach(async () => {
  db = createClient({ url: ':memory:' });
  await migrate(db);
});

describe('clientKey', () => {
  it('derives an ip: key from x-forwarded-for (hashed, not raw)', () => {
    const k = clientKey(new Headers({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' }));
    expect(k).toMatch(/^ip:[0-9a-f]{16}$/);
    expect(k).not.toContain('203.0.113.7');
  });

  it('falls back to a fp: fingerprint when no forwarded IP', () => {
    expect(clientKey(new Headers({ 'user-agent': 'x' }))).toMatch(/^fp:[0-9a-f]{16}$/);
  });
});

describe('checkDailyCap', () => {
  it('allows up to the cap then blocks', async () => {
    const opts = { now: () => 0, client: db };
    const results = [];
    for (let i = 0; i < 4; i++) results.push(await checkDailyCap('ip:abc', 3, opts));
    expect(results.map((r) => r.allowed)).toEqual([true, true, true, false]);
    expect(results[2]!.count).toBe(3);
    expect(results[3]!.count).toBe(3); // blocked, count not incremented past the cap
  });

  it('counts each client key independently', async () => {
    const opts = { now: () => 0, client: db };
    await checkDailyCap('ip:a', 1, opts);
    expect((await checkDailyCap('ip:a', 1, opts)).allowed).toBe(false);
    expect((await checkDailyCap('ip:b', 1, opts)).allowed).toBe(true);
  });

  it('resets on a new UTC day', async () => {
    const day1 = Date.parse('2026-05-22T12:00:00Z');
    const day2 = Date.parse('2026-05-23T12:00:00Z');
    await checkDailyCap('ip:a', 1, { now: () => day1, client: db });
    expect((await checkDailyCap('ip:a', 1, { now: () => day1, client: db })).allowed).toBe(false);
    expect((await checkDailyCap('ip:a', 1, { now: () => day2, client: db })).allowed).toBe(true);
  });
});

describe('checkGlobalDailyBudget', () => {
  it('allows under the ceiling and blocks at/over it', async () => {
    const now = () => Date.parse('2026-05-22T12:00:00Z');
    const { analysis } = await getOrCreateAnalysis(
      { owner: 'a', repo: 'b', commitSha: 's' },
      db
    );
    // ceiling $1 = 1,000,000 µ$. Spend 600,000 → still allowed.
    await addCost(analysis.id, 600_000, db);
    expect((await checkGlobalDailyBudget(1, { now, client: db })).allowed).toBe(true);
    // push over the ceiling.
    await addCost(analysis.id, 500_000, db);
    const over = await checkGlobalDailyBudget(1, { now, client: db });
    expect(over.allowed).toBe(false);
    expect(over.spentMicroUsd).toBe(1_100_000);
  });
});
