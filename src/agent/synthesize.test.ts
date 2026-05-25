import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import type { Report } from '../report/schema';
import type { MessagesClient } from './explore';
import { extractJson, synthesizeReport } from './synthesize';

const report: Report = {
  summary: 'A CLI tool.',
  sections: [
    {
      kind: 'overview',
      title: 'Overview',
      findings: [
        {
          claim: 'It is a CLI',
          detail: 'bin entry present',
          evidence: [{ path: 'package.json', startLine: 1, endLine: 1, quote: '"bin"' }],
        },
      ],
    },
  ],
};

function clientReturning(
  text: string
): MessagesClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  return {
    calls,
    messages: {
      create: async (params) => {
        calls.push(params);
        return {
          id: 'm',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-4-7',
          content: [{ type: 'text', text }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: {
            input_tokens: 100,
            output_tokens: 20,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 0,
          },
        } as unknown as Anthropic.Message;
      },
    },
  };
}

const base = { repo: 'acme/widget', commitSha: 'sha1', notes: 'notes', evidence: [] };

describe('extractJson', () => {
  it('parses bare JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
  });
  it('parses fenced JSON', () => {
    expect(extractJson('Here:\n```json\n{"a":1}\n```\ndone')).toEqual({ a: 1 });
  });
  it('parses a JSON span embedded in prose', () => {
    expect(extractJson('The report is {"a":1} as shown.')).toEqual({ a: 1 });
  });
  it('throws when there is no JSON', () => {
    expect(() => extractJson('no json here')).toThrow(/parseable JSON/);
  });
});

describe('synthesizeReport', () => {
  it('returns the validated report and prices it at Opus rates', async () => {
    const client = clientReturning(JSON.stringify(report));
    const result = await synthesizeReport({ client, ...base });
    expect(result.report).toEqual(report);
    expect(result.costMicroUsd).toBe(100 * 5 + 20 * 25); // 1000 µ$
  });

  it('handles a fenced JSON response', async () => {
    const client = clientReturning('```json\n' + JSON.stringify(report) + '\n```');
    const result = await synthesizeReport({ client, ...base });
    expect(result.report.summary).toBe('A CLI tool.');
  });

  it('uses Opus and passes the json_schema output format', async () => {
    const client = clientReturning(JSON.stringify(report));
    await synthesizeReport({ client, ...base });
    const params = client.calls[0]! as unknown as Record<string, unknown>;
    expect(params.model).toBe('claude-opus-4-7');
    const oc = params.output_config as { format?: { type?: string } };
    expect(oc.format?.type).toBe('json_schema');
  });

  it('throws when the response is not valid JSON', async () => {
    const client = clientReturning('I could not produce a report.');
    await expect(synthesizeReport({ client, ...base })).rejects.toThrow(/parseable JSON/);
  });

  it('throws when the JSON violates the schema', async () => {
    const client = clientReturning(JSON.stringify({ summary: 'x' })); // missing sections
    await expect(synthesizeReport({ client, ...base })).rejects.toThrow(/schema validation/);
  });
});
