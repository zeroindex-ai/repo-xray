import { describe, expect, it } from 'vitest';
import {
  addUsage,
  costMicroUsd,
  emptyUsageTotals,
  OPUS_4_7_PRICING,
  pricingForModel,
  SONNET_4_6_PRICING,
} from './cost';

describe('costMicroUsd', () => {
  it('prices each token class at Sonnet 4.6 rates (micro-USD)', () => {
    // 1000 input @ $3/MTok = 3000 µ$, 100 output @ $15 = 1500, 200 cache-write @ $3.75 = 750,
    // 5000 cache-read @ $0.30 = 1500. Total 6750 µ$ = $0.00675.
    const cost = costMicroUsd({
      input_tokens: 1000,
      output_tokens: 100,
      cache_creation_input_tokens: 200,
      cache_read_input_tokens: 5000,
    });
    expect(cost).toBe(6750);
  });

  it('treats missing/null token fields as zero', () => {
    expect(costMicroUsd({ input_tokens: 1000 })).toBe(3000);
    expect(costMicroUsd({})).toBe(0);
  });

  it('uses the supplied pricing table (Opus 4.7 is more expensive)', () => {
    expect(costMicroUsd({ input_tokens: 1000 }, OPUS_4_7_PRICING)).toBe(5000);
  });

  it('matches the documented Sonnet rate constants', () => {
    expect(SONNET_4_6_PRICING.inputPerMTok).toBe(3);
    expect(SONNET_4_6_PRICING.cacheReadPerMTok).toBe(0.3);
  });
});

describe('pricingForModel', () => {
  it('prices Opus models at the Opus rate and everything else at Sonnet', () => {
    expect(pricingForModel('claude-opus-4-7')).toBe(OPUS_4_7_PRICING);
    expect(pricingForModel('claude-sonnet-4-6')).toBe(SONNET_4_6_PRICING);
    expect(pricingForModel('claude-haiku-4-5')).toBe(SONNET_4_6_PRICING); // default branch
  });
});

describe('addUsage', () => {
  it('accumulates across calls', () => {
    let totals = emptyUsageTotals();
    totals = addUsage(totals, { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 50 });
    totals = addUsage(totals, { input_tokens: 200, cache_creation_input_tokens: 30 });
    expect(totals).toEqual({
      inputTokens: 300,
      outputTokens: 10,
      cacheWriteTokens: 30,
      cacheReadTokens: 50,
    });
  });
});
