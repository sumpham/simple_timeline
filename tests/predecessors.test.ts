import { describe, expect, it } from 'vitest';
import { formatPredecessors, parsePredecessors } from '../client/predecessors.ts';

describe('parsePredecessors', () => {
  it('reads rows and lags', () => {
    expect(parsePredecessors('1, 3+2 4-1', 5, 5)).toEqual({ ok: true, rows: [{ row: 1, lag: 0, type: 'FS' }, { row: 3, lag: 2, type: 'FS' }, { row: 4, lag: -1, type: 'FS' }] });
    expect(parsePredecessors('2+3d', 3, 1)).toEqual({ ok: true, rows: [{ row: 2, lag: 3, type: 'FS' }] });
    expect(parsePredecessors('', 3, 1)).toEqual({ ok: true, rows: [] });
  });

  it('refuses what it cannot mean', () => {
    expect(parsePredecessors('x', 3, 1).ok).toBe(false);
    expect(parsePredecessors('9', 3, 1).ok).toBe(false);
    expect(parsePredecessors('2', 3, 2).ok).toBe(false);
  });

  it('reads link types, with or without a lag', () => {
    expect(parsePredecessors('2SS, 3ff-1, 1fs+2', 4, 4)).toEqual({ ok: true, rows: [
      { row: 2, lag: 0, type: 'SS' }, { row: 3, lag: -1, type: 'FF' }, { row: 1, lag: 2, type: 'FS' },
    ] });
    expect(parsePredecessors('2SF', 3, 1).ok).toBe(false);
  });

  it('keeps the first mention of a row', () => {
    expect(parsePredecessors('1, 1+2', 3, 3)).toEqual({ ok: true, rows: [{ row: 1, lag: 0, type: 'FS' }] });
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

  it('writes SS and FF, leaving FS unsaid', () => {
    const rowOf = new Map([[10, 1], [11, 2]]);
    const deps = [
      { predecessor_id: 10, successor_id: 12, lag: 1, type: 'SS' as const },
      { predecessor_id: 11, successor_id: 12, lag: 0, type: 'FF' as const },
    ];
    expect(formatPredecessors(deps, 12, rowOf)).toBe('1SS+1, 2FF');
  });
});
