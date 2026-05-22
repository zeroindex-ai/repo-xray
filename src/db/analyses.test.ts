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
