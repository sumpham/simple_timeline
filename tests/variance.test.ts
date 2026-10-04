import { describe, expect, it } from 'vitest';
import { formatShift, varianceOf, workingShift } from '../shared/variance.ts';

// 2026-03-02 is a Monday.
describe('variance against a baseline', () => {
  it('counts working days, so a weekend is not a slip', () => {
    expect(workingShift('2026-03-06', '2026-03-09')).toBe(1);
    expect(workingShift('2026-03-09', '2026-03-06')).toBe(-1);
    expect(workingShift('2026-03-04', '2026-03-04')).toBe(0);
    expect(workingShift('2026-03-04', '2026-03-06', new Set(['2026-03-05']))).toBe(1);
  });

  it('gives start, finish and length, positive when later or longer', () => {
    expect(varianceOf(
      { start: '2026-03-04', end: '2026-03-10', duration: 5 },
      { start: '2026-03-02', end: '2026-03-06', duration: 5 },
    )).toEqual({ start: 2, finish: 2, duration: 0 });
    expect(varianceOf(
      { start: '2026-03-02', end: '2026-03-04', duration: 3 },
      { start: '2026-03-02', end: '2026-03-06', duration: 5 },
    )).toEqual({ start: 0, finish: -2, duration: -2 });
  });

  it('has no length variance for a baseline that kept none', () => {
    expect(varianceOf({ start: '2026-03-02', end: '2026-03-02', duration: 1 }, { start: '2026-03-02', end: '2026-03-02', duration: null }).duration).toBeNull();
  });

  it('reads with a sign and a true minus', () => {
    expect([formatShift(3), formatShift(-2), formatShift(0)]).toEqual(['+3d', '−2d', '0d']);
  });
});
