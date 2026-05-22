import { describe, expect, it } from 'vitest';
import { safeEqual } from './timingSafeCompare';

// Seed test so `vitest run` (and therefore CI) is green on a fresh skeleton.
// Delete or expand once you have real modules to cover — the portfolio
// convention is colocated `*.test.ts` next to the code it exercises.
describe('safeEqual', () => {
  it('returns true for identical strings', () => {
    expect(safeEqual('hunter2', 'hunter2')).toBe(true);
  });

  it('returns false for different same-length strings', () => {
    expect(safeEqual('abc', 'abd')).toBe(false);
  });

  it('returns false for different-length strings without throwing', () => {
    expect(safeEqual('short', 'a-much-longer-value')).toBe(false);
  });
});
