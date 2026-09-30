import { describe, expect, it } from 'vitest';
import { afterSuggestions, applySuggestion, formatPredecessors, parseAfter, parsePredecessors } from '../client/predecessors.ts';

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

describe('parseAfter', () => {
  const idOfCode = new Map([[10, 100], [20, 200], [7, 300]]);

  it('reads TaskIDs, not rows', () => {
    expect(parseAfter('10, 20SS+2', idOfCode, 300)).toEqual({ ok: true, links: [
      { id: 100, lag: 0, type: 'FS' }, { id: 200, lag: 2, type: 'SS' },
    ] });
  });

  it('refuses an unknown ID and the task itself', () => {
    expect(parseAfter('3', idOfCode, 300)).toEqual({ ok: false, error: 'There is no task with ID 3.' });
    expect(parseAfter('7', idOfCode, 300).ok).toBe(false);
    expect(parseAfter('x', idOfCode, 300).ok).toBe(false);
  });
});

describe('afterSuggestions', () => {
  const tasks = [
    { id: 1, code: 1, name: 'Design' }, { id: 2, code: 2, name: 'Build API' },
    { id: 3, code: 12, name: 'Build UI' }, { id: 4, code: 21, name: 'Test' },
  ];

  it('matches the start of an ID under the caret', () => {
    const s = afterSuggestions('1', 1, tasks, 4);
    expect(s.items.map((i) => i.code)).toEqual([1, 12]);
    expect([s.from, s.to]).toEqual([0, 1]);
  });

  it('matches part of a name and replaces the whole word', () => {
    const s = afterSuggestions('1, build', 8, tasks, 4);
    expect(s.items.map((i) => i.code)).toEqual([2, 12]);
    expect(applySuggestion('1, build', s.from, s.to, 12)).toEqual({ text: '1, 12', caret: 5 });
  });

  it('leaves out the task itself and IDs already written', () => {
    expect(afterSuggestions('1, ', 3, tasks, 4).items.map((i) => i.code)).toEqual([2, 12]);
  });

  it('keeps a typed type and lag when an ID is picked', () => {
    const s = afterSuggestions('2SS+1', 1, tasks, 4);
    expect([s.from, s.to]).toEqual([0, 1]);
    expect(applySuggestion('2SS+1', s.from, s.to, 21).text).toBe('21SS+1');
  });
});
