import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from './migrate';
import {
  addCost,
  appendEvent,
  findByRepoSha,
  getAnalysis,
  getEvents,
  getOrCreateAnalysis,
  getReport,
  latestSucceededByRepo,
  listAnalyses,
  saveReport,
  setStatus,
} from './analyses';

let client: Client;
const base = { owner: 'acme', repo: 'widget', commitSha: 'sha-1', ref: 'main' };

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  await migrate(client);
});

describe('getOrCreateAnalysis', () => {
  it('creates a queued analysis the first time', async () => {
    const { analysis, created } = await getOrCreateAnalysis(base, client);
    expect(created).toBe(true);
    expect(analysis.status).toBe('queued');
    expect(analysis.commitSha).toBe('sha-1');
    expect(analysis.costMicroUsd).toBe(0);
  });

  it('dedupes the same (owner, repo, sha) to one row', async () => {
    const first = await getOrCreateAnalysis(base, client);
    const second = await getOrCreateAnalysis(base, client);
    expect(second.created).toBe(false);
    expect(second.analysis.id).toBe(first.analysis.id);
  });

  it('creates a distinct row for a different commit', async () => {
    const first = await getOrCreateAnalysis(base, client);
    const other = await getOrCreateAnalysis({ ...base, commitSha: 'sha-2' }, client);
    expect(other.created).toBe(true);
    expect(other.analysis.id).not.toBe(first.analysis.id);
  });
});

describe('getAnalysis / findByRepoSha', () => {
  it('fetches by id and by repo+sha', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    expect((await getAnalysis(analysis.id, client))?.id).toBe(analysis.id);
    expect((await findByRepoSha('acme', 'widget', 'sha-1', client))?.id).toBe(analysis.id);
  });

  it('returns null for an unknown commit', async () => {
    expect(await findByRepoSha('acme', 'widget', 'missing', client)).toBeNull();
    expect(await getAnalysis('nope', client)).toBeNull();
  });
});

describe('setStatus', () => {
  it('marks running without setting completed_at', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await setStatus(analysis.id, 'running', {}, client);
    const a = await getAnalysis(analysis.id, client);
    expect(a?.status).toBe('running');
    expect(a?.completedAt).toBeNull();
  });

  it('sets completed_at and error on a terminal status', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await setStatus(analysis.id, 'failed', { error: 'boom' }, client);
    const a = await getAnalysis(analysis.id, client);
    expect(a?.status).toBe('failed');
    expect(a?.error).toBe('boom');
    expect(typeof a?.completedAt).toBe('number');
  });
});

describe('addCost', () => {
  it('accumulates micro-USD', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await addCost(analysis.id, 1500, client);
    await addCost(analysis.id, 250, client);
    expect((await getAnalysis(analysis.id, client))?.costMicroUsd).toBe(1750);
  });
});

describe('run events', () => {
  it('assigns increasing seq and replays in order', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    const s1 = await appendEvent(analysis.id, 'status', { phase: 'fetch' }, client);
    const s2 = await appendEvent(analysis.id, 'tool_call', { name: 'read_file' }, client);
    const s3 = await appendEvent(analysis.id, 'cost', { microUsd: 10 }, client);
    expect([s1, s2, s3]).toEqual([1, 2, 3]);

    const all = await getEvents(analysis.id, 0, client);
    expect(all.map((e) => e.type)).toEqual(['status', 'tool_call', 'cost']);
    expect(all[1]!.data).toEqual({ name: 'read_file' });

    const afterFirst = await getEvents(analysis.id, 1, client);
    expect(afterFirst.map((e) => e.seq)).toEqual([2, 3]);
  });
});

describe('report storage', () => {
  it('round-trips a structured report', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    const report = { sections: [{ kind: 'overview', findings: [{ title: 'x', evidence: [] }] }] };
    await saveReport(analysis.id, report, 'a summary', client);
    const got = await getReport(analysis.id, client);
    expect(got?.report).toEqual(report);
    expect(got?.summary).toBe('a summary');
  });

  it('upserts on re-save', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await saveReport(analysis.id, { v: 1 }, null, client);
    await saveReport(analysis.id, { v: 2 }, 'updated', client);
    const got = await getReport(analysis.id, client);
    expect(got?.report).toEqual({ v: 2 });
    expect(got?.summary).toBe('updated');
  });
});

describe('listAnalyses', () => {
  async function seed(n: number, status?: 'succeeded' | 'failed') {
    const { analysis } = await getOrCreateAnalysis({ ...base, commitSha: `sha-${n}` }, client);
    if (status) await setStatus(analysis.id, status, {}, client);
    return analysis.id;
  }

  it('returns rows newest-first with a total count', async () => {
    await seed(1);
    await seed(2);
    const { rows, total } = await listAnalyses({ limit: 50, offset: 0 }, client);
    expect(total).toBe(2);
    expect(rows.map((r) => r.commitSha)).toEqual(['sha-2', 'sha-1']); // created_at DESC
  });

  it('filters by status and counts only the filtered set', async () => {
    await seed(1, 'succeeded');
    await seed(2, 'failed');
    await seed(3, 'succeeded');
    const { rows, total } = await listAnalyses({ limit: 50, offset: 0, status: 'succeeded' }, client);
    expect(total).toBe(2);
    expect(rows.every((r) => r.status === 'succeeded')).toBe(true);
  });

  it('paginates via limit + offset', async () => {
    for (let i = 1; i <= 3; i++) await seed(i);
    const page1 = await listAnalyses({ limit: 2, offset: 0 }, client);
    const page2 = await listAnalyses({ limit: 2, offset: 2 }, client);
    expect(page1.rows).toHaveLength(2);
    expect(page2.rows).toHaveLength(1);
    expect(page1.total).toBe(3);
  });
});

describe('latestSucceededByRepo', () => {
  async function seed(sha: string, status: 'succeeded' | 'failed' | 'queued') {
    const { analysis } = await getOrCreateAnalysis({ ...base, commitSha: sha }, client);
    if (status !== 'queued') await setStatus(analysis.id, status, {}, client);
    return analysis.id;
  }

  it('returns null when the repo has no succeeded analysis', async () => {
    await seed('sha-1', 'failed');
    await seed('sha-2', 'queued');
    expect(await latestSucceededByRepo(base.owner, base.repo, client)).toBeNull();
  });

  it('returns the newest succeeded row regardless of commit SHA', async () => {
    const oldId = await seed('sha-old', 'succeeded');
    await seed('sha-mid', 'failed');
    const newId = await seed('sha-new', 'succeeded');
    const got = await latestSucceededByRepo(base.owner, base.repo, client);
    expect(got?.id).toBe(newId);
    expect(got?.id).not.toBe(oldId);
    expect(got?.commitSha).toBe('sha-new');
  });

  it('is scoped to the given owner/repo', async () => {
    await seed('sha-1', 'succeeded');
    expect(await latestSucceededByRepo('other', 'repo', client)).toBeNull();
  });
});
