// Route-level tests for POST /api/analyze's same-commit dedupe. The route wires
// SHA-resolve → getOrCreateAnalysis → atomic claimOwnership → (own | attach).
// These assert the expensive agent run (analyzeRepo) fires EXACTLY ONCE when two
// requests target the same in-flight commit — the loser attaches instead.
//
// The DB is a real in-memory libsql client (shared via the mocked db()), so the
// guarded ownership transition runs against actual SQL. Only analyzeRepo and the
// live deps/guards are mocked.

import { createClient, type Client } from '@libsql/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { migrate } from '../db/migrate';
import { appendEvent, getAnalysis, getOrCreateAnalysis, setStatus, STALE_RUNNING_MS } from '../db/analyses';

// One in-memory client shared by the mocked db() and the mocked live deps, so the
// route's default-client calls (getOrCreateAnalysis/claimOwnership/guards) and the
// agent all see the same database.
let client: Client;

// An optional gate the analyzeRepo mock awaits before finishing, so a test can
// hold a run "in flight" (status 'running', no report yet) while a second request
// arrives. Default: no gate (the run completes immediately).
let gate: Promise<void> | null = null;

// Spy: counts analyzeRepo invocations. Its impl mimics enough of the real run to
// drive the attach stream to a terminal event (persist a report, flip status).
const analyzeRepo = vi.fn(
  async (
    input: string,
    deps: { db?: Client },
    opts: { onStart?: (id: string) => void; onEvent?: (e: unknown) => void }
  ) => {
    // input is "owner/repo@sha"; find the row the route already claimed.
    const [ownerRepo, sha] = input.split('@');
    const [owner, repo] = ownerRepo!.split('/');
    const res = await client.execute({
      sql: 'SELECT id, status FROM analyses WHERE owner = ? AND repo = ? AND commit_sha = ?',
      args: [owner!, repo!, sha!],
    });
    const row = res.rows[0] as Record<string, unknown>;
    const id = String(row.id);
    // Mirror analyzeRepo's cache path: an already-succeeded row returns cached with
    // no further "spend" (no new events, status unchanged). The route then emits
    // the synthesized report event itself.
    if (String(row.status) === 'succeeded') {
      return { analysisId: id, commitSha: sha, report: {}, stats: null, costMicroUsd: 1, cached: true };
    }
    opts.onStart?.(id);
    if (gate) await gate; // hold the run in flight until the test releases it
    const payload = {
      analysisId: id,
      repo: ownerRepo,
      commitSha: sha,
      cached: false,
      costMicroUsd: 1,
      stats: null,
      report: {},
    };
    await appendEvent(id, 'report', payload, client);
    await setStatus(id, 'succeeded', {}, client);
    opts.onEvent?.({ type: 'report', report: payload });
    return { analysisId: id, commitSha: sha, report: {}, stats: null, costMicroUsd: 1, cached: false };
  }
);

vi.mock('@/agent/analyze', () => ({
  analyzeRepo: (...a: unknown[]) => analyzeRepo(...(a as Parameters<typeof analyzeRepo>)),
}));
vi.mock('@/db/client', () => ({ db: () => client }));
vi.mock('@/lib/analyze-deps', () => ({
  liveDepsFromEnv: () => ({ db: client, resolveCommitSha: async () => 'sha-abc' }),
}));
vi.mock('@/lib/guards', () => ({
  clientKey: () => 'test-key',
  checkDailyCap: async () => ({ allowed: true, count: 1, limit: 5 }),
  checkGlobalDailyBudget: async () => ({ allowed: true, spentMicroUsd: 0, ceilingMicroUsd: 5_000_000 }),
}));
vi.mock('@/lib/logAnalysis', () => ({ logAnalysis: () => {} }));

async function drain(res: Response): Promise<string> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

function post(repo: string): Promise<Response> {
  // Import lazily AFTER mocks are registered.
  return import('../../app/api/analyze/route').then(({ POST }) =>
    POST(new Request('http://x/api/analyze', { method: 'POST', body: JSON.stringify({ repo }) }))
  );
}

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  await migrate(client);
  analyzeRepo.mockClear();
  gate = null;
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('POST /api/analyze — same-commit dedupe', () => {
  it('a second in-flight request for the same commit ATTACHES (analyzeRepo runs once)', async () => {
    // Hold request 1's run in flight (status 'running', no report yet) via the gate.
    let release: () => void = () => {};
    gate = new Promise<void>((r) => {
      release = r;
    });

    // Request 1: wins ownership; the row is flipped to 'running' by claimOwnership.
    const res1 = await post('acme/widget');

    // The claim happened; the run is parked at the gate, so the row is 'running'.
    const idRow = (await client.execute('SELECT id FROM analyses')).rows[0] as Record<string, unknown>;
    const id = String(idRow.id);
    expect((await getAnalysis(id, client))?.status).toBe('running');

    // Request 2: same commit, sees status 'running' → claim fails → attaches.
    const res2 = await post('acme/widget');

    // Now let request 1's run finish (persists the report, flips to 'succeeded'),
    // which is what the attach stream is tailing for.
    release();
    gate = null;

    const [text1, text2] = await Promise.all([drain(res1), drain(res2)]);

    // The expensive agent fn ran for the OWNER only — the attach path never called it.
    expect(analyzeRepo).toHaveBeenCalledTimes(1);

    // Both clients receive a terminal report event in the canonical SSE shape.
    expect(text1).toContain('event: report');
    expect(text2).toContain('event: report');
    // The attach stream emits the early `id` control event so it too can reconnect.
    expect(text2).toContain('event: id');

    // Exactly one analyses row exists (deduped by owner/repo/sha).
    const count = await client.execute('SELECT COUNT(*) AS n FROM analyses');
    expect(Number((count.rows[0] as Record<string, unknown>).n)).toBe(1);
  });

  it('two concurrent first-requests race — analyzeRepo runs exactly once', async () => {
    // Fire both POSTs concurrently against a never-seen commit. The guarded claim
    // in claimOwnership lets exactly one win; the loser attaches.
    const [res1, res2] = await Promise.all([post('acme/widget'), post('acme/widget')]);
    await Promise.all([drain(res1), drain(res2)]);

    expect(analyzeRepo).toHaveBeenCalledTimes(1);
    const count = await client.execute('SELECT COUNT(*) AS n FROM analyses');
    expect(Number((count.rows[0] as Record<string, unknown>).n)).toBe(1);
  });

  it('a STALE running row for the same commit is RECLAIMED — a fresh agent run starts (not an infinite attach)', async () => {
    // Simulate a prior run that Vercel killed at maxDuration: the row is stranded
    // at 'running' with no terminal event, and its updated_at is past the cutoff.
    // Pre-dedupe this poisoned the commit forever (claim never won from 'running').
    const { analysis } = await getOrCreateAnalysis(
      { owner: 'acme', repo: 'widget', commitSha: 'sha-abc', ref: null },
      client
    );
    await setStatus(analysis.id, 'running', {}, client);
    const stale = Date.now() - STALE_RUNNING_MS - 60_000;
    await client.execute({ sql: 'UPDATE analyses SET updated_at = ? WHERE id = ?', args: [stale, analysis.id] });

    const res = await post('acme/widget');
    const text = await drain(res);

    // The route reclaimed the stale row and OWNED a fresh run rather than attaching
    // and tailing forever to a dead run.
    expect(analyzeRepo).toHaveBeenCalledTimes(1);
    expect(text).toContain('event: report');
    // Still one row (reclaimed in place, deduped by owner/repo/sha) and now succeeded.
    const count = await client.execute('SELECT COUNT(*) AS n FROM analyses');
    expect(Number((count.rows[0] as Record<string, unknown>).n)).toBe(1);
    expect((await getAnalysis(analysis.id, client))?.status).toBe('succeeded');
  });

  it('a completed (succeeded) commit serves the cache — no second agent run beyond the seeding one', async () => {
    // Seed: first request runs + completes.
    await drain(await post('acme/widget'));
    expect(analyzeRepo).toHaveBeenCalledTimes(1);

    // Second request for the SAME (now succeeded) commit: the route routes through
    // analyzeRepo's cache path (cached:true) and the route synthesizes the report
    // event. No NEW analyses row, and no NEW run is persisted.
    const res = await post('acme/widget');
    const text = await drain(res);
    expect(text).toContain('event: report');
    const count = await client.execute('SELECT COUNT(*) AS n FROM analyses');
    expect(Number((count.rows[0] as Record<string, unknown>).n)).toBe(1);
  });
});
