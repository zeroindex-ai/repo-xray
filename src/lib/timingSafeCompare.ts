import { timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string equality. Length is compared up front (length itself is
 * not secret); equal-length buffers go through Node's `timingSafeEqual`.
 *
 * Always returns a boolean — never throws on length mismatch.
 */
export function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
