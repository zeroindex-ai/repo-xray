import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { addCost, getAnalysis, getOrCreateAnalysis } from '../db/analyses';
import { migrate } from '../db/migrate';
import {
  checkDailyCap,
  checkGlobalDailyBudget,
  clientKey,
  reserveGlobalDailyBudget,
} from './guards';

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
    const { analysis } = await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's' }, db);
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

describe('reserveGlobalDailyBudget', () => {
  const now = () => Date.parse('2026-05-22T12:00:00Z');

  it('reserves the estimate onto the row and reports the new total', async () => {
    const { analysis } = await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's' }, db);
    const r = await reserveGlobalDailyBudget(analysis.id, 400_000, 1, { now, client: db });
    expect(r.allowed).toBe(true);
    expect(r.spentMicroUsd).toBe(400_000);
    // The reservation is persisted on the row — visible to other runs' SUM.
    expect((await getAnalysis(analysis.id, db))?.costMicroUsd).toBe(400_000);
  });

  it('closes the TOCTOU: concurrent reservations cannot both pass past the ceiling', async () => {
    // ceiling $1 = 1,000,000 µ$; estimate 600,000 each ⇒ only ONE can fit.
    const a = (await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's1' }, db)).analysis;
    const b = (await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's2' }, db)).analysis;
    // Sequential simulates the serialized row-writes the single guarded UPDATE forces.
    const r1 = await reserveGlobalDailyBudget(a.id, 600_000, 1, { now, client: db });
    const r2 = await reserveGlobalDailyBudget(b.id, 600_000, 1, { now, client: db });
    expect(r1.allowed).toBe(true);
    expect(r2.allowed).toBe(false); // 600k + 600k > 1M ⇒ second denied
    // The denied run wrote nothing.
    expect((await getAnalysis(b.id, db))?.costMicroUsd).toBe(0);
  });

  it('denies when prior spend already fills the ceiling', async () => {
    const prior = (await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's0' }, db)).analysis;
    await addCost(prior.id, 900_000, db); // ceiling $1
    const next = (await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's1' }, db)).analysis;
    const r = await reserveGlobalDailyBudget(next.id, 400_000, 1, { now, client: db });
    expect(r.allowed).toBe(false); // 900k + 400k > 1M
    expect((await getAnalysis(next.id, db))?.costMicroUsd).toBe(0);
  });

  it('excludes the row being reserved from the "other rows" sum (re-reservation is idempotent)', async () => {
    const a = (await getOrCreateAnalysis({ owner: 'a', repo: 'b', commitSha: 's' }, db)).analysis;
    expect((await reserveGlobalDailyBudget(a.id, 600_000, 1, { now, client: db })).allowed).toBe(true);
    // Re-reserving the SAME row must not double-count its own estimate against itself.
    expect((await reserveGlobalDailyBudget(a.id, 600_000, 1, { now, client: db })).allowed).toBe(true);
  });
});
