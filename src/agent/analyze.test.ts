import type Anthropic from '@anthropic-ai/sdk';
import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { getAnalysis, getReport } from '../db/analyses';
import { migrate } from '../db/migrate';
import type { FileSlice, RepoTree } from '../lib/github';
import type { Report } from '../report/schema';
import { analyzeRepo, type AnalyzeDeps } from './analyze';
import type { MessagesClient } from './explore';

const report: Report = {
  summary: 'A small CLI tool.',
  sections: [
    {
      kind: 'overview',
      title: 'Overview',
      findings: [
        { claim: 'It is a CLI', detail: 'README says so.', evidence: [{ path: 'README.md', startLine: 1, endLine: 1, quote: '# Acme CLI' }] },
      ],
    },
  ],
};

const usage = { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

function message(content: unknown[], stop_reason: string): Anthropic.Message {
  return {
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'x',
    content,
    stop_reason,
    stop_sequence: null,
    usage,
  } as unknown as Anthropic.Message;
}

function fakeClient(responses: Anthropic.Message[]): MessagesClient & { count: number } {
  let i = 0;
  const client = {
    count: 0,
    messages: {
      create: async () => {
        client.count += 1;
        return responses[Math.min(i++, responses.length - 1)]!;
      },
    },
  };
  return client;
}

const tree: RepoTree = { sha: 'sha1', truncated: false, entries: [{ path: 'README.md', type: 'blob', sha: 'a' }] };
const slice: FileSlice = { path: 'README.md', startLine: 1, endLine: 1, totalLines: 1, content: '# Acme CLI', truncated: false };

// Explorer reads README, ends; synthesizer emits the report JSON.
function happyResponses(): Anthropic.Message[] {
  return [
    message([{ type: 'tool_use', id: 'tu1', name: 'read_file', input: { path: 'README.md' } }], 'tool_use'),
    message([{ type: 'text', text: 'It is a CLI. Start at README.md.' }], 'end_turn'),
    message([{ type: 'text', text: JSON.stringify(report) }], 'end_turn'),
  ];
}

let db: Client;
function deps(client: MessagesClient): AnalyzeDeps {
  return {
    anthropic: client,
    db,
    now: () => 0,
    resolveCommitSha: async () => 'sha1',
    fetchTree: async () => tree,
    readFile: async () => slice,
  };
}

beforeEach(async () => {
  db = createClient({ url: ':memory:' });
  await migrate(db);
});

describe('analyzeRepo', () => {
  it('runs the full pipeline, validates citations, and persists', async () => {
    const client = fakeClient(happyResponses());
    const result = await analyzeRepo('acme/widget', deps(client));

    expect(result.cached).toBe(false);
    expect(result.report.summary).toBe('A small CLI tool.');
    expect(result.stats).toMatchObject({ citationsValid: 1, findingsKept: 1 });
    expect(result.costMicroUsd).toBeGreaterThan(0);

    const analysis = await getAnalysis(result.analysisId, db);
    expect(analysis?.status).toBe('succeeded');
    expect(analysis?.costMicroUsd).toBe(result.costMicroUsd);
    const stored = await getReport(result.analysisId, db);
    expect(stored?.report).toEqual(result.report);
  });

  it('returns the cached report on a repeat of the same commit', async () => {
    const client = fakeClient(happyResponses());
    const first = await analyzeRepo('acme/widget', deps(client));
    const callsAfterFirst = client.count;

    const second = await analyzeRepo('acme/widget', deps(client));
    expect(second.cached).toBe(true);
    expect(second.analysisId).toBe(first.analysisId);
    expect(second.report).toEqual(first.report);
    expect(client.count).toBe(callsAfterFirst); // no further model calls
  });

  it('marks the analysis failed and rethrows when synthesis is unusable', async () => {
    const client = fakeClient([
      message([{ type: 'text', text: 'done' }], 'end_turn'), // explorer ends immediately
      message([{ type: 'text', text: 'I cannot produce JSON.' }], 'end_turn'), // synth: not JSON
    ]);
    const d = deps(client);
    await expect(analyzeRepo('acme/widget', d)).rejects.toThrow(/parseable JSON/);

    // The row exists and is marked failed with the error.
    const { findByRepoSha } = await import('../db/analyses');
    const row = await findByRepoSha('acme', 'widget', 'sha1', db);
    expect(row?.status).toBe('failed');
    expect(row?.error).toMatch(/parseable JSON/);
    // The exploration cost was real money — it must be retained on the failed row,
    // not rolled back, even though synthesis threw afterward.
    expect(row?.costMicroUsd).toBeGreaterThan(0);
  });

  it('rejects a non-github target before any I/O (SSRF guard)', async () => {
    const client = fakeClient([]);
    await expect(analyzeRepo('https://evil.example.com/a/b', deps(client))).rejects.toThrow(/github\.com/i);
    expect(client.count).toBe(0);
  });

  it('emits pipeline phase events', async () => {
    const phases: string[] = [];
    const client = fakeClient(happyResponses());
    await analyzeRepo('acme/widget', deps(client), {
      onEvent: (e) => {
        if (e.type === 'phase') phases.push(e.phase);
      },
    });
    expect(phases).toEqual(['resolving', 'fetching', 'exploring', 'synthesizing', 'validating', 'done']);
  });
});
