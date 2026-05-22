import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { FileSlice, TreeEntry } from '../lib/github';
import type { ToolDeps } from './tools';
import { type ExploreEvent, type MessagesClient, runExploration } from './explore';

const tree: TreeEntry[] = [
  { path: 'README.md', type: 'blob', sha: 'a' },
  { path: 'src/index.ts', type: 'blob', sha: 'b' },
];

const usage = (over: Partial<Anthropic.Usage> = {}): Anthropic.Usage =>
  ({
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    ...over,
  }) as Anthropic.Usage;

function message(content: Anthropic.ContentBlock[], stop_reason: string): Anthropic.Message {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'claude-sonnet-4-6',
    content,
    stop_reason,
    stop_sequence: null,
    usage: usage(),
  } as unknown as Anthropic.Message;
}

const toolUse = (name: string, input: unknown, id = 'tu_1'): Anthropic.ContentBlock =>
  ({ type: 'tool_use', id, name, input }) as unknown as Anthropic.ContentBlock;

const text = (t: string): Anthropic.ContentBlock => ({ type: 'text', text: t }) as Anthropic.TextBlock;

function fakeClient(responses: Anthropic.Message[]): MessagesClient & {
  calls: Anthropic.MessageCreateParamsNonStreaming[];
} {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  let i = 0;
  return {
    calls,
    messages: {
      create: async (params) => {
        // Snapshot messages at call time — the loop mutates the live array, and a
        // stored reference would reflect the final state, not this call's.
        calls.push({ ...params, messages: [...params.messages] });
        return responses[Math.min(i++, responses.length - 1)]!;
      },
    },
  };
}

const slice: FileSlice = {
  path: 'README.md',
  startLine: 1,
  endLine: 2,
  totalLines: 2,
  content: '# Title\nA CLI tool.',
  truncated: false,
};

const deps: ToolDeps = { tree, readFile: async () => slice };

describe('runExploration', () => {
  it('runs the tool loop, captures evidence, and finishes on end_turn', async () => {
    const client = fakeClient([
      message([toolUse('read_file', { path: 'README.md' })], 'tool_use'),
      message([text('This is a CLI tool. Start at README.md.')], 'end_turn'),
    ]);
    const result = await runExploration({ client, deps, task: 'Analyze acme/widget', now: () => 0 });

    expect(result.stopReason).toBe('completed');
    expect(result.toolCalls).toBe(1);
    expect(result.iterations).toBe(2);
    expect(result.notes).toContain('CLI tool');
    expect(result.evidence).toEqual([
      { path: 'README.md', startLine: 1, endLine: 2, quote: '# Title\nA CLI tool.' },
    ]);
    expect(result.costMicroUsd).toBeGreaterThan(0);
  });

  it('caches the repo tree (last system block) and the tool list (last tool)', async () => {
    const client = fakeClient([message([text('done')], 'end_turn')]);
    await runExploration({ client, deps, task: 'x', now: () => 0 });

    const params = client.calls[0]!;
    const system = params.system as Anthropic.TextBlockParam[];
    expect(system[system.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(system[system.length - 1]!.text).toContain('README.md');
    const tools = params.tools as Anthropic.Tool[];
    expect(tools[tools.length - 1]!.cache_control).toEqual({ type: 'ephemeral' });
  });

  it('feeds tool results back as a user turn on the next call', async () => {
    const client = fakeClient([
      message([toolUse('search', { query: 'index' })], 'tool_use'),
      message([text('done')], 'end_turn'),
    ]);
    await runExploration({ client, deps, task: 'x', now: () => 0 });

    const second = client.calls[1]!;
    const lastMsg = second.messages[second.messages.length - 1]!;
    expect(lastMsg.role).toBe('user');
    const block = (lastMsg.content as Anthropic.ToolResultBlockParam[])[0]!;
    expect(block.type).toBe('tool_result');
    expect(block.tool_use_id).toBe('tu_1');
  });

  it('stops on the tool-call budget without exceeding it', async () => {
    const client = fakeClient([message([toolUse('list_directory', { path: '' })], 'tool_use')]);
    const result = await runExploration({
      client,
      deps,
      task: 'x',
      budget: { maxToolCalls: 1 },
      now: () => 0,
    });
    expect(result.stopReason).toBe('budget');
    expect(result.toolCalls).toBe(1);
    expect(client.calls).toHaveLength(1); // broke before a second model call
  });

  it('stops on the wall-clock budget', async () => {
    const client = fakeClient([message([toolUse('search', { query: 'x' })], 'tool_use')]);
    let t = 0;
    const result = await runExploration({
      client,
      deps,
      task: 'x',
      budget: { maxWallClockMs: 10 },
      now: () => (t += 100), // every check advances 100ms
    });
    expect(result.stopReason).toBe('budget');
  });

  it('maps a refusal stop reason', async () => {
    const client = fakeClient([message([text('I cannot help with that.')], 'refusal')]);
    const result = await runExploration({ client, deps, task: 'x', now: () => 0 });
    expect(result.stopReason).toBe('refusal');
  });

  it('emits tool_call, tool_result, cost, and status events', async () => {
    const events: ExploreEvent[] = [];
    const client = fakeClient([
      message([toolUse('read_file', { path: 'README.md' })], 'tool_use'),
      message([text('done')], 'end_turn'),
    ]);
    await runExploration({ client, deps, task: 'x', now: () => 0, onEvent: (e) => void events.push(e) });

    const types = events.map((e) => e.type);
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_result');
    expect(types).toContain('cost');
    expect(events.some((e) => e.type === 'status' && e.phase === 'done')).toBe(true);
  });
});
