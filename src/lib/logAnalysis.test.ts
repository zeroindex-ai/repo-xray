import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { logAnalysis, type AnalysisTrace } from './logAnalysis';

const SAMPLE: AnalysisTrace = {
  status: 'ok',
  totalMs: 4200,
  repo: 'sindresorhus/slugify',
  analysisId: 'an_123',
  commitSha: '7c318bd1aa4b',
  cached: false,
  costMicroUsd: 457900,
  toolCalls: 6,
  exploreCostMicroUsd: 120000,
  synthCostMicroUsd: 337900,
  citationsChecked: 32,
  citationsValid: 32,
  findingsKept: 19,
  findingsDropped: 0,
};

const flushMicrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

let fetchSpy: ReturnType<typeof vi.fn>;
let warnSpy: MockInstance;
const originalFetch = global.fetch;
const { TRACE_PACK_URL, TRACE_PACK_TOKEN, TRACE_PACK_SOURCE } = process.env;

beforeEach(() => {
  fetchSpy = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  global.fetch = fetchSpy as unknown as typeof fetch;
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  delete process.env.TRACE_PACK_URL;
  delete process.env.TRACE_PACK_TOKEN;
  delete process.env.TRACE_PACK_SOURCE;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
  process.env.TRACE_PACK_URL = TRACE_PACK_URL;
  process.env.TRACE_PACK_TOKEN = TRACE_PACK_TOKEN;
  process.env.TRACE_PACK_SOURCE = TRACE_PACK_SOURCE;
});

describe('logAnalysis', () => {
  it('does NOT call fetch when TRACE_PACK_URL is unset', () => {
    process.env.TRACE_PACK_TOKEN = 'token';
    logAnalysis(SAMPLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT call fetch when TRACE_PACK_TOKEN is unset', () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    logAnalysis(SAMPLE);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('POSTs to {URL}/api/ingest with bearer auth + keepalive when both env vars set', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'my-secret-token';
    logAnalysis(SAMPLE);
    await flushMicrotasks();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://traces.zeroindex.ai/api/ingest');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer my-secret-token');
    expect(headers['Content-Type']).toBe('application/json');
    expect(init.keepalive).toBe(true);
  });

  it('sends a generic analyze event with metrics in the passthrough', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'token';
    logAnalysis(SAMPLE);
    await flushMicrotasks();

    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.source).toBe('repo-xray');
    expect(body.event).toBe('analyze');
    expect(body.status).toBe('ok');
    expect(body.totalMs).toBe(4200);
    expect(body.idempotencyKey).toBe('an_123'); // dedupe key = analysisId
    expect(body.repo).toBe('sindresorhus/slugify');
    expect(body.costMicroUsd).toBe(457900);
    expect(body.citationsValid).toBe(32);
    expect(body.toolCalls).toBe(6);
    expect(typeof body.ts).toBe('string');
    // no model / token fields — trace-pack would misprice them
    expect(body.model).toBeUndefined();
    expect(body.inputTokens).toBeUndefined();
  });

  it('honors TRACE_PACK_SOURCE override', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'token';
    process.env.TRACE_PACK_SOURCE = 'repo-xray-staging';
    logAnalysis(SAMPLE);
    await flushMicrotasks();
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.source).toBe('repo-xray-staging');
  });

  it('drops undefined fields and truncates outcomeReason to 120 chars on error', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'token';
    logAnalysis({ status: 'error', totalMs: 90, repo: 'a/b', outcomeReason: 'x'.repeat(200) });
    await flushMicrotasks();
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.status).toBe('error');
    expect(body.outcomeReason).toHaveLength(120);
    expect('analysisId' in body).toBe(false);
    expect('idempotencyKey' in body).toBe(false);
    expect('costMicroUsd' in body).toBe(false);
  });

  it('strips a trailing slash from TRACE_PACK_URL before appending /api/ingest', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai/';
    process.env.TRACE_PACK_TOKEN = 'token';
    logAnalysis(SAMPLE);
    await flushMicrotasks();
    expect((fetchSpy.mock.calls[0] as [string])[0]).toBe('https://traces.zeroindex.ai/api/ingest');
  });

  it('swallows fetch errors and warns', async () => {
    process.env.TRACE_PACK_URL = 'https://traces.zeroindex.ai';
    process.env.TRACE_PACK_TOKEN = 'token';
    fetchSpy.mockRejectedValue(new Error('network down'));

    expect(() => logAnalysis(SAMPLE)).not.toThrow();
    await flushMicrotasks();

    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain('trace-pack ingest failed');
  });
});
