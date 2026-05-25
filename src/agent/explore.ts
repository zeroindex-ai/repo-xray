// Phase 1 of analysis: a bounded, prompt-cached tool-use loop. Sonnet explores
// the repo with read-only tools (list_directory, read_file, search) and we record
// every file slice it reads as cited evidence. The synthesis pass (Opus, later)
// turns this evidence + notes into the structured report.
//
// The loop is manual (not the SDK tool runner) because we need hard budgets,
// per-step event emission, and running cost accounting. tool_choice is left at
// the default `auto`, which avoids the thinking-vs-forced-tool_choice 400.

import type Anthropic from '@anthropic-ai/sdk';
import { addUsage, costMicroUsd, emptyUsageTotals, SONNET_4_6_PRICING, type UsageTotals } from './cost';
import { buildMessageParams, type MessageRequest } from './messageParams';
import { executeTool, renderTree, TOOLS, type EvidenceItem, type ToolDeps } from './tools';

export const EXPLORE_MODEL = 'claude-sonnet-4-6';

export const EXPLORE_SYSTEM = [
  'You are a senior engineer doing a first pass on an unfamiliar repository to help a new',
  'engineer get oriented. You have read-only tools to explore it.',
  '',
  'Be evidence-based: only claim things you have verified by reading the code, and reference',
  'exact file paths and line numbers. Prioritize the README, the build/dependency manifest,',
  'entry points, configuration, and the most important modules — you have a limited number of',
  'tool calls, so do not try to read everything.',
  '',
  'When you can explain what the project is, how to run it, where a newcomer should start',
  'reading, how it is structured, and any notable risks, stop calling tools and write a concise',
  'summary of your findings, each tied to specific files and line ranges.',
].join('\n');

export type Budget = {
  maxIterations: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxTokensPerCall: number;
};

export const DEFAULT_BUDGET: Budget = {
  maxIterations: 30,
  maxToolCalls: 40,
  maxWallClockMs: 120_000,
  maxTokensPerCall: 8192,
};

export type ExploreStopReason = 'completed' | 'budget' | 'refusal' | 'max_tokens';

export type ExploreEvent =
  | { type: 'status'; phase: 'start' | 'iterating' | 'done'; detail?: string }
  | { type: 'tool_call'; seq: number; name: string; input: unknown }
  | { type: 'tool_result'; seq: number; name: string; ok: boolean }
  | { type: 'cost'; iterationMicroUsd: number; cumulativeMicroUsd: number };

export type ExploreResult = {
  notes: string;
  evidence: EvidenceItem[];
  toolCalls: number;
  iterations: number;
  usage: UsageTotals;
  costMicroUsd: number;
  stopReason: ExploreStopReason;
};

// Minimal structural shape of the Anthropic client — keeps the loop mockable.
export type MessagesClient = {
  messages: {
    create: (params: Anthropic.MessageCreateParamsNonStreaming) => Promise<Anthropic.Message>;
  };
};

export type ExploreOptions = {
  client: MessagesClient;
  deps: ToolDeps;
  task: string;
  model?: string;
  budget?: Partial<Budget>;
  now?: () => number;
  onEvent?: (event: ExploreEvent) => void | Promise<void>;
  // Newer params (adaptive thinking, effort) not in every SDK typings version are
  // merged in via this escape hatch; defaults below.
  extraParams?: Record<string, unknown>;
};

function textOf(content: Anthropic.ContentBlock[]): string {
  return content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

export async function runExploration(opts: ExploreOptions): Promise<ExploreResult> {
  const budget = { ...DEFAULT_BUDGET, ...opts.budget };
  const now = opts.now ?? Date.now;
  const model = opts.model ?? EXPLORE_MODEL;
  const emit = async (e: ExploreEvent) => {
    if (opts.onEvent) await opts.onEvent(e);
  };

  // Cache the deterministic tool list and the per-run repo tree (the large stable
  // prefix) so every loop turn after the first reads them from cache.
  const tools = TOOLS.map((t, i) =>
    i === TOOLS.length - 1 ? { ...t, cache_control: { type: 'ephemeral' as const } } : t
  );
  const system: Anthropic.TextBlockParam[] = [
    { type: 'text', text: EXPLORE_SYSTEM },
    {
      type: 'text',
      text: `Repository file tree (blobs):\n${renderTree(opts.deps.tree)}`,
      cache_control: { type: 'ephemeral' },
    },
  ];

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: opts.task }];
  const evidence: EvidenceItem[] = [];
  let usage = emptyUsageTotals();
  let cumulativeCost = 0;
  let toolCalls = 0;
  let iterations = 0;
  const startedAt = now();

  await emit({ type: 'status', phase: 'start' });

  let stopReason: ExploreStopReason = 'completed';
  let notes = '';

  for (;;) {
    if (iterations >= budget.maxIterations || toolCalls >= budget.maxToolCalls) {
      stopReason = 'budget';
      break;
    }
    if (now() - startedAt >= budget.maxWallClockMs) {
      stopReason = 'budget';
      break;
    }

    iterations += 1;
    // Typed base + typed tuning defaults; `extraParams`, when given, replaces the
    // tuning block via the wrapper. No cast at the call site.
    const base: MessageRequest = {
      model,
      max_tokens: budget.maxTokensPerCall,
      system,
      tools,
      messages,
    };
    const response = await opts.client.messages.create(
      buildMessageParams(
        base,
        { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } },
        opts.extraParams
      )
    );

    usage = addUsage(usage, response.usage);
    const iterationCost = costMicroUsd(response.usage, SONNET_4_6_PRICING);
    cumulativeCost += iterationCost;
    await emit({ type: 'cost', iterationMicroUsd: iterationCost, cumulativeMicroUsd: cumulativeCost });

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason !== 'tool_use') {
      notes = textOf(response.content);
      stopReason =
        response.stop_reason === 'refusal'
          ? 'refusal'
          : response.stop_reason === 'max_tokens'
            ? 'max_tokens'
            : 'completed';
      break;
    }

    // Execute every tool_use block in this turn (the API requires a result for each).
    const toolUses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    await emit({ type: 'status', phase: 'iterating' });

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const block of toolUses) {
      toolCalls += 1;
      const seq = toolCalls;
      await emit({ type: 'tool_call', seq, name: block.name, input: block.input });
      try {
        const outcome = await executeTool(block.name, block.input as Record<string, unknown>, opts.deps);
        if (outcome.evidence) evidence.push(outcome.evidence);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: outcome.content });
        await emit({ type: 'tool_result', seq, name: block.name, ok: true });
      } catch (err) {
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${(err as Error).message}`,
          is_error: true,
        });
        await emit({ type: 'tool_result', seq, name: block.name, ok: false });
      }
    }
    messages.push({ role: 'user', content: results });
  }

  await emit({ type: 'status', phase: 'done', detail: stopReason });
  return { notes, evidence, toolCalls, iterations, usage, costMicroUsd: cumulativeCost, stopReason };
}
