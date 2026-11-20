import { describe, expect, it } from 'vitest';
import { percentile } from './analytics.queries.js';

describe('percentile', () => {
  it('interpolates between ranks, like Postgres percentile_cont', () => {
    expect(percentile([1_000, 2_000, 3_000, 4_000], 0.5)).toBe(2_500);
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    // 0.95 × (20 − 1) = 18.05: between the 19th and 20th values.
    const twenty = Array.from({ length: 20 }, (_, i) => (i + 1) * 100);
    expect(percentile(twenty, 0.95)).toBe(1_905);
  });

  it('has no answer for no values, and one value is every percentile', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([42], 0.95)).toBe(42);
  });
});
