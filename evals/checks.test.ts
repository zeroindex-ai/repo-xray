import type { GoldenItem, PartialResult } from '@zeroindex-ai/eval-pack';
import { describe, expect, it } from 'vitest';
import { citationRatio, citationResolution, hasFindings } from './checks';

const item = (metadata?: Record<string, unknown>): GoldenItem => ({
  id: 'x',
  category: 'micro-lib',
  question: 'owner/repo',
  ...(metadata ? { metadata } : {}),
});

const result = (stats: Record<string, number> | null): PartialResult =>
  ({
    id: 'x',
    category: 'micro-lib',
    question: 'owner/repo',
    text: '',
    retrievedRefs: [],
    citationRefs: [],
    recall: null,
    timings: { totalMs: 0 },
    metadata: { stats },
  }) as PartialResult;

describe('citationResolution', () => {
  it('passes when the ratio clears the floor', () => {
    const r = citationResolution(item(), result({ citationsChecked: 20, citationsValid: 19 }));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatchObject({ ratio: 0.95, min: 0.85 });
  });

  it('fails when below the floor', () => {
    const r = citationResolution(item(), result({ citationsChecked: 10, citationsValid: 7 }));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatchObject({ ratio: 0.7 });
  });

  it('honors a per-item minCitationResolution override', () => {
    const r = citationResolution(
      item({ minCitationResolution: 1 }),
      result({ citationsChecked: 20, citationsValid: 19 })
    );
    expect(r.ok).toBe(false); // 0.95 < 1.0
  });

  it('fails when nothing was cited (no false pass on an empty report)', () => {
    expect(citationResolution(item(), result({ citationsChecked: 0, citationsValid: 0 })).ok).toBe(false);
    expect(citationResolution(item(), result(null)).ok).toBe(false);
  });
});

describe('hasFindings', () => {
  it('passes with at least one kept finding, fails with none', () => {
    expect(hasFindings(item(), result({ findingsKept: 3 })).ok).toBe(true);
    expect(hasFindings(item(), result({ findingsKept: 0 })).ok).toBe(false);
  });
});

describe('citationRatio', () => {
  it('returns the ratio, or null when nothing was cited', () => {
    expect(citationRatio(result({ citationsChecked: 4, citationsValid: 3 }))).toBe(0.75);
    expect(citationRatio(result({ citationsChecked: 0, citationsValid: 0 }))).toBeNull();
  });
});
