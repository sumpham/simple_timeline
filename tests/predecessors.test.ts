import { describe, expect, it } from 'vitest';
import { formatPredecessors, parsePredecessors } from '../client/predecessors.ts';

describe('parsePredecessors', () => {
  it('reads rows and lags', () => {
    expect(parsePredecessors('1, 3+2 4-1', 5, 5)).toEqual({ ok: true, rows: [{ row: 1, lag: 0 }, { row: 3, lag: 2 }, { row: 4, lag: -1 }] });
    expect(parsePredecessors('2+3d', 3, 1)).toEqual({ ok: true, rows: [{ row: 2, lag: 3 }] });
    expect(parsePredecessors('', 3, 1)).toEqual({ ok: true, rows: [] });
  });

  it('refuses what it cannot mean', () => {
    expect(parsePredecessors('x', 3, 1).ok).toBe(false);
    expect(parsePredecessors('9', 3, 1).ok).toBe(false);
    expect(parsePredecessors('2', 3, 2).ok).toBe(false);
  });

  it('keeps the first mention of a row', () => {
    expect(parsePredecessors('1, 1+2', 3, 3)).toEqual({ ok: true, rows: [{ row: 1, lag: 0 }] });
  });
});

describe('formatPredecessors', () => {
  it('writes rows in order with their lags', () => {
    const rowOf = new Map([[10, 1], [11, 2], [12, 3]]);
    const deps = [
      { predecessor_id: 12, successor_id: 13, lag: -1 },
      { predecessor_id: 10, successor_id: 13, lag: 0 },
      { predecessor_id: 11, successor_id: 13, lag: 2 },
    ];
    expect(formatPredecessors(deps, 13, rowOf)).toBe('1, 2+2, 3-1');
  });
});
