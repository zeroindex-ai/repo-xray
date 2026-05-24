// Phase 2 of analysis: synthesis. Opus turns the exploration evidence + notes
// into the structured, onboarding-led report. One model call (no caching payoff),
// constrained by output_config.format and re-validated with the Zod schema — so
// a malformed or schema-violating response fails loudly rather than silently.

import type Anthropic from '@anthropic-ai/sdk';
import { costMicroUsd, pricingForModel } from './cost';
import type { EvidenceItem } from './tools';
import type { MessagesClient } from './explore';
import { type Report, REPORT_JSON_SCHEMA, ReportSchema } from '../report/schema';

export const SYNTH_MODEL = 'claude-opus-4-7';

export const SYNTH_SYSTEM = [
  'You are a senior engineer writing a first-pass orientation report on a repository for a new',
  'engineer. You are given the explorer notes and the exact file excerpts that were read.',
  '',
  'Write the report as JSON matching the provided schema. Lead with onboarding: section order is',
  'overview, then onboarding (where to start, how to run it), then architecture, then risk.',
  '',
  'Ground every finding in the supplied evidence. The excerpts are line-numbered as',
  '"<number>\\t<text>": use those exact line numbers in startLine/endLine, but the quote must be',
  'the source text ONLY — do not include the leading "<number>\\t" prefix. Do not invent files,',
  'lines, or quotes — only cite what you were given. A short report of',
  'verifiable findings is better than a long one of guesses. Use the "risk" section only for',
  'concerns you can point at in the code.',
].join('\n');

export type SynthesizeOptions = {
  client: MessagesClient;
  repo: string; // "owner/repo"
  commitSha: string;
  notes: string;
  evidence: EvidenceItem[];
  model?: string;
  maxTokens?: number;
  extraParams?: Record<string, unknown>;
};

export type SynthesizeResult = {
  report: Report;
  usage: Anthropic.Usage;
  costMicroUsd: number;
};

// Pull a JSON object out of model text: direct parse, then ```json fences, then
// the outermost { … } span. Throws if none parse.
export function extractJson(text: string): unknown {
  const tryParse = (s: string): unknown | undefined => {
    try {
      return JSON.parse(s) as unknown;
    } catch {
      return undefined;
    }
  };
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    const fenced = tryParse(fence[1]!.trim());
    if (fenced !== undefined) return fenced;
  }

  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const span = tryParse(text.slice(first, last + 1));
    if (span !== undefined) return span;
  }
  throw new Error('Synthesis response did not contain parseable JSON');
}

function renderEvidence(evidence: EvidenceItem[]): string {
  if (evidence.length === 0) return '(no files were read)';
  // Line-number each excerpt so citations use real line numbers instead of
  // guesses — the citation validator re-reads the exact cited range, so accurate
  // numbers are what keep findings from being dropped.
  return evidence
    .map((e) => {
      const numbered = e.quote
        .split('\n')
        .map((line, i) => `${e.startLine + i}\t${line}`)
        .join('\n');
      return `--- ${e.path} (lines ${e.startLine}-${e.endLine}) ---\n${numbered}`;
    })
    .join('\n\n');
}

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n');
}

export async function synthesizeReport(opts: SynthesizeOptions): Promise<SynthesizeResult> {
  const model = opts.model ?? SYNTH_MODEL;
  const userMessage = [
    `Repository: ${opts.repo} @ ${opts.commitSha}`,
    '',
    'Explorer notes:',
    opts.notes || '(none)',
    '',
    'File excerpts that were read (cite only from these):',
    renderEvidence(opts.evidence),
  ].join('\n');

  // Typed base keeps model/max_tokens/system/messages checked; the cast only
  // loosens the merge to admit newer params (thinking/output_config.format).
  const base: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: opts.maxTokens ?? 16_000,
    system: SYNTH_SYSTEM,
    messages: [{ role: 'user', content: userMessage }],
  };
  const response = await opts.client.messages.create({
    ...base,
    ...(opts.extraParams ?? {
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: REPORT_JSON_SCHEMA } },
    }),
  } as Anthropic.MessageCreateParamsNonStreaming);

  const parsed = ReportSchema.safeParse(extractJson(textOf(response.content)));
  if (!parsed.success) {
    throw new Error(`Synthesis output failed schema validation: ${parsed.error.message}`);
  }

  return {
    report: parsed.data,
    usage: response.usage,
    costMicroUsd: costMicroUsd(response.usage, pricingForModel(model)),
  };
}
