import { createClient, type Client } from '@libsql/client';
import { beforeEach, describe, expect, it } from 'vitest';
import { migrate } from '../db/migrate';
import { appendEvent, getOrCreateAnalysis, setStatus, type RunEvent } from '../db/analyses';
import { analysisEventStream, replayAndTail } from './sse-replay';

let client: Client;
const base = { owner: 'acme', repo: 'widget', commitSha: 'sha-1', ref: 'main' };

beforeEach(async () => {
  client = createClient({ url: ':memory:' });
  await migrate(client);
});

// A controllable clock + sleep so the tail loop runs without real wall-clock time.
function fakeTimer() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
  };
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

describe('replayAndTail — backlog', () => {
  it('replays only events after the given seq, in order', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await appendEvent(analysis.id, 'phase', { phase: 'fetching' }, client);
    await appendEvent(analysis.id, 'explore', { event: { type: 'tool_call', seq: 1 } }, client);
    await appendEvent(analysis.id, 'report', { analysisId: analysis.id }, client);
    await setStatus(analysis.id, 'succeeded', {}, client);

    const seen: RunEvent[] = [];
    const last = await replayAndTail(analysis.id, 1, (e) => void seen.push(e), { db: client });

    // afterSeq=1 skips the first event; backlog includes the rest, terminal stops it.
    expect(seen.map((e) => e.seq)).toEqual([2, 3]);
    expect(seen.map((e) => e.type)).toEqual(['explore', 'report']);
    expect(last).toBe(3);
  });
});

describe('replayAndTail — completed run', () => {
  it('emits the full backlog then closes (no tailing past the terminal event)', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await appendEvent(analysis.id, 'phase', { phase: 'fetching' }, client);
    await appendEvent(analysis.id, 'phase', { phase: 'done' }, client);
    await appendEvent(analysis.id, 'report', { analysisId: analysis.id }, client);
    await setStatus(analysis.id, 'succeeded', {}, client);

    let polls = 0;
    const seen: RunEvent[] = [];
    await replayAndTail(analysis.id, 0, (e) => void seen.push(e), {
      db: client,
      // If it tried to tail, this sleep would be hit; it must not, because the
      // backlog already contains a terminal `report` event.
      sleep: async () => {
        polls += 1;
      },
    });

    expect(seen.map((e) => e.type)).toEqual(['phase', 'phase', 'report']);
    expect(polls).toBe(0); // closed straight after the backlog's terminal event
  });

  it('stops a status-terminal run with no terminal event after draining', async () => {
    // A run whose status is 'failed' but whose last event is not a report/error
    // (defensive: status flip is the backstop). Tail should drain + stop, not spin.
    const { analysis } = await getOrCreateAnalysis(base, client);
    await appendEvent(analysis.id, 'phase', { phase: 'fetching' }, client);
    await setStatus(analysis.id, 'failed', { error: 'boom' }, client);

    const seen: RunEvent[] = [];
    const last = await replayAndTail(analysis.id, 0, (e) => void seen.push(e), { db: client });
    expect(seen.map((e) => e.type)).toEqual(['phase']);
    expect(last).toBe(1);
  });
});

describe('replayAndTail — in-flight tailing', () => {
  it('emits new events as they appear, until a terminal event arrives', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client); // status: queued
    await setStatus(analysis.id, 'running', {}, client);
    await appendEvent(analysis.id, 'phase', { phase: 'fetching' }, client);

    const timer = fakeTimer();
    const seen: RunEvent[] = [];

    // Simulate the producer writing more events as the tail polls: hook the sleep
    // to append the next event + finally a terminal one, then flip status.
    let step = 0;
    const sleep = async (ms: number) => {
      await timer.sleep(ms);
      step += 1;
      if (step === 1)
        await appendEvent(analysis.id, 'explore', { event: { type: 'tool_call', seq: 1 } }, client);
      if (step === 2) {
        await appendEvent(analysis.id, 'report', { analysisId: analysis.id }, client);
        await setStatus(analysis.id, 'succeeded', {}, client);
      }
    };

    const last = await replayAndTail(analysis.id, 0, (e) => void seen.push(e), {
      db: client,
      now: timer.now,
      sleep,
      pollIntervalMs: 10,
    });

    expect(seen.map((e) => e.type)).toEqual(['phase', 'explore', 'report']);
    expect(last).toBe(3);
  });

  it('gives up at the deadline on a wedged in-flight run', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await setStatus(analysis.id, 'running', {}, client);
    await appendEvent(analysis.id, 'phase', { phase: 'exploring' }, client);

    const timer = fakeTimer();
    const seen: RunEvent[] = [];
    const last = await replayAndTail(analysis.id, 0, (e) => void seen.push(e), {
      db: client,
      now: timer.now,
      sleep: timer.sleep,
      pollIntervalMs: 1000,
      deadlineMs: 5000, // bounded — never runs forever
    });
    expect(seen.map((e) => e.type)).toEqual(['phase']); // only the backlog, then bailed
    expect(last).toBe(1);
  });
});

describe('analysisEventStream — wire format', () => {
  it('formats each event as id/event/data SSE frames', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await appendEvent(analysis.id, 'phase', { phase: 'fetching' }, client);
    await appendEvent(analysis.id, 'report', { analysisId: analysis.id, cached: false }, client);
    await setStatus(analysis.id, 'succeeded', {}, client);

    const text = await collect(analysisEventStream(analysis.id, 0, { db: client }));
    expect(text).toContain('id: 1\nevent: phase\ndata: {"phase":"fetching"}\n\n');
    expect(text).toContain('id: 2\nevent: report\n');
    expect(text).toContain('"analysisId":"' + analysis.id + '"');
  });

  it('can prepend a leading id control event for attach reconnect', async () => {
    const { analysis } = await getOrCreateAnalysis(base, client);
    await appendEvent(analysis.id, 'error', { message: 'nope' }, client);
    await setStatus(analysis.id, 'failed', { error: 'nope' }, client);

    const text = await collect(analysisEventStream(analysis.id, 0, { db: client, emitIdEvent: true }));
    expect(text.startsWith(`event: id\ndata: {"analysisId":"${analysis.id}"}\n\n`)).toBe(true);
    expect(text).toContain('event: error\ndata: {"message":"nope"}');
  });
});
