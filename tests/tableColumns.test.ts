import { describe, expect, it } from 'vitest';
import {
  clampWidth, columnsFor, DEFAULT_WIDTH, fitWidth, parseManualWidths, RESIZABLE, resolveWidths, totalWidth,
} from '../client/tableColumns.ts';

describe('task table columns', () => {
  it('lists the optional columns only when shown, in table order', () => {
    expect(columnsFor({ wbs: false, estimates: false, who: false })).toEqual(
      ['row', 'code', 'name', 'env', 'days', 'after', 'start', 'finish', 'float', 'status']);
    expect(columnsFor({ wbs: true, estimates: true, who: true })).toEqual(
      ['row', 'code', 'wbs', 'name', 'env', 'days', 'best', 'worst', 'after', 'who', 'start', 'finish', 'float', 'status']);
    expect(columnsFor({ wbs: false, estimates: false, who: false, deadline: true })).toEqual(
      ['row', 'code', 'name', 'env', 'days', 'after', 'start', 'finish', 'deadline', 'float', 'status']);
  });

  it('fits to the widest entry, inside the column range', () => {
    expect(fitWidth('env', [90, 160, 130])).toBe(160);
    expect(fitWidth('env', [10])).toBe(RESIZABLE.env!.min);
    expect(fitWidth('name', [5000])).toBe(RESIZABLE.name!.max);
    expect(fitWidth('after', [])).toBe(DEFAULT_WIDTH.after);
  });

  it('never resizes a fixed column', () => {
    expect(clampWidth('start', 400)).toBe(DEFAULT_WIDTH.start);
  });

  it('puts a hand width over a fitted one, and sums what is shown', () => {
    const keys = columnsFor({ wbs: false, estimates: true, who: false });
    const w = resolveWidths(keys, { env: 150, after: 90 }, { env: 200, start: 999 });
    expect(w.env).toBe(200);
    expect(w.after).toBe(90);
    expect(w.start).toBe(DEFAULT_WIDTH.start);
    expect(totalWidth(keys, w)).toBe(keys.reduce((s, k) => s + w[k], 0));
    // Best and Worst count toward the table, so they no longer squeeze the task name.
    expect(totalWidth(keys, w)).toBeGreaterThan(totalWidth(columnsFor({ wbs: false, estimates: false, who: false }), w));
  });

  it('reads remembered widths defensively', () => {
    expect(parseManualWidths(null)).toEqual({});
    expect(parseManualWidths('not json')).toEqual({});
    expect(parseManualWidths('{"env":180,"start":300,"who":"x","after":9999}')).toEqual({ env: 180, after: RESIZABLE.after!.max });
  });
});
