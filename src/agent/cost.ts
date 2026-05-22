// Cost accounting from Messages API usage, in micro-USD (integer — matches the
// analyses.cost_micro_usd column and avoids float drift). 1 micro-USD = $1e-6.

export type TokenUsage = {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
};

export type Pricing = {
  /** USD per million input tokens. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** Cache writes bill at 1.25× input; cache reads at 0.1× input. */
  cacheWritePerMTok: number;
  cacheReadPerMTok: number;
};

export const SONNET_4_6_PRICING: Pricing = {
  inputPerMTok: 3,
  outputPerMTok: 15,
  cacheWritePerMTok: 3.75,
  cacheReadPerMTok: 0.3,
};

export const OPUS_4_7_PRICING: Pricing = {
  inputPerMTok: 5,
  outputPerMTok: 25,
  cacheWritePerMTok: 6.25,
  cacheReadPerMTok: 0.5,
};

// micro-USD = tokens × (USD per MTok), since tokens/1e6 × perMTok × 1e6 = tokens × perMTok.
export function costMicroUsd(usage: TokenUsage, pricing: Pricing = SONNET_4_6_PRICING): number {
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const micros =
    input * pricing.inputPerMTok +
    output * pricing.outputPerMTok +
    cacheWrite * pricing.cacheWritePerMTok +
    cacheRead * pricing.cacheReadPerMTok;
  return Math.round(micros);
}

export type UsageTotals = {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export function emptyUsageTotals(): UsageTotals {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0 };
}

export function addUsage(totals: UsageTotals, usage: TokenUsage): UsageTotals {
  return {
    inputTokens: totals.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: totals.outputTokens + (usage.output_tokens ?? 0),
    cacheWriteTokens: totals.cacheWriteTokens + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: totals.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
  };
}
