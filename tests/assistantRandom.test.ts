import { describe, expect, it } from 'vitest';
import { seededRandom, seedOf } from '../shared/assistant/random.ts';

const take = (seed: number, n: number) => {
  const r = seededRandom(seed);
  return Array.from({ length: n }, () => r());
};

describe('seededRandom', () => {
  it('gives the same sequence for the same seed', () => {
    expect(take(42, 50)).toEqual(take(42, 50));
  });

  it('gives a different sequence for a different seed', () => {
    expect(take(42, 5)).not.toEqual(take(43, 5));
  });

  it('stays on [0, 1) and spreads evenly', () => {
    const xs = take(7, 20000);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...xs)).toBeLessThan(1);
    const buckets = new Array(10).fill(0);
    for (const x of xs) buckets[Math.floor(x * 10)]++;
    for (const b of buckets) expect(b).toBeGreaterThan(1800);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(0.5, 1);
  });
});

describe('seedOf', () => {
  it('is stable and sensitive to its text', () => {
    expect(seedOf('plan:1:2026-09-30')).toBe(seedOf('plan:1:2026-09-30'));
    expect(seedOf('plan:1:2026-09-30')).not.toBe(seedOf('plan:1:2026-10-01'));
    expect(Number.isInteger(seedOf(''))).toBe(true);
  });
});
