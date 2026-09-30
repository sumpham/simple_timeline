import { describe, expect, it } from 'vitest';
import { dayColumn, rolledBaseline, ganttDays, ganttScale, GANTT_DAY, GANTT_MIN_WEEKS, spanX } from '../client/gantt.ts';
import { linkPath } from '../client/components/Gantt.tsx';

describe('ganttScale', () => {
  it('starts on the Monday of the earliest date and pads a spare week', () => {
    const s = ganttScale(['2026-10-07', null, '2026-12-30'], 1)!;
    expect(s.start).toBe('2026-10-05');
    // 5 Oct .. week of 28 Dec is 13 weeks, plus one spare.
    expect(s.weeks).toBe(14);
  });

  it('keeps a short plan at the minimum width', () => {
    expect(ganttScale(['2026-10-07'])!.weeks).toBe(GANTT_MIN_WEEKS);
  });

  it('has nothing to draw without dates', () => {
    expect(ganttScale([null, undefined])).toBeNull();
  });
});

describe('dayColumn', () => {
  const scale = { start: '2026-10-05', weeks: 4 };

  it('counts weekdays only', () => {
    expect(dayColumn(scale, '2026-10-05', 'start')).toBe(0);
    expect(dayColumn(scale, '2026-10-09', 'end')).toBe(4);
    expect(dayColumn(scale, '2026-10-12', 'start')).toBe(5);
  });

  it('moves a weekend start on to Monday and a weekend end back to Friday', () => {
    expect(dayColumn(scale, '2026-10-10', 'start')).toBe(5);
    expect(dayColumn(scale, '2026-10-11', 'end')).toBe(4);
  });

  it('makes a Friday bar meet the next Monday bar', () => {
    const a = spanX(scale, '2026-10-05', '2026-10-09');
    const b = spanX(scale, '2026-10-12', '2026-10-13');
    expect(a).toEqual({ x0: 0, x1: 5 * GANTT_DAY });
    expect(b.x0).toBe(a.x1);
  });

  it('lists every weekday of the scale, Mondays first', () => {
    const days = ganttDays(scale);
    expect(days).toHaveLength(20);
    expect(days[5]).toBe('2026-10-12');
    expect(days[4]).toBe('2026-10-09');
  });
});

describe('linkPath', () => {
  it('steps right from the end and lands on top of a successor below', () => {
    const p = { x0: 0, x1: 110, mid: 19, milestone: false };
    const s = { x0: 110, x1: 176, mid: 58, milestone: false };
    expect(linkPath(p, s)).toBe('M110 19H118V50');
  });

  it('lands on the underside of a successor above', () => {
    const p = { x0: 0, x1: 110, mid: 58, milestone: false };
    const s = { x0: 132, x1: 176, mid: 19, milestone: false };
    expect(linkPath(p, s)).toBe('M110 58H138V27');
  });
});

import {
  chainOf, dateAtColumn, draggedFinish, draggedStart, draggedStartEdge, finishFields, finishVariance, gridLines, headerBands, progressOf,
  rolledProgress, startEdgeFields, startFields, visibleRows, zoomToFit,
} from '../client/gantt.ts';
import { occupancyByDay } from '../shared/conflicts.ts';
import type { BookingView } from '../shared/types.ts';

describe('zoom', () => {
  const days = ganttDays({ start: '2026-09-28', weeks: 14 });

  it('heads each step with the larger period over the smaller', () => {
    const d = headerBands(days, 'day');
    expect(d.top[0]).toMatchObject({ col: 0, span: 5, label: 'Week 1', sub: '28 Sep' });
    expect(d.bottom.slice(0, 5).map((b) => b.label).join('')).toBe('MTWTF');
    const w = headerBands(days, 'week');
    expect(w.top.map((b) => b.label).slice(0, 3)).toEqual(['Sep 2026', 'Oct 2026', 'Nov 2026']);
    expect(w.bottom[1]).toMatchObject({ col: 5, span: 5, label: '5' });
    const m = headerBands(days, 'month');
    expect(m.top.map((b) => b.label)).toEqual(['Q3 2026', 'Q4 2026', 'Q1 2027']);
    expect(m.bottom.map((b) => b.label)).toEqual(['Sep', 'Oct', 'Nov', 'Dec', 'Jan']);
  });

  it('covers every column exactly once in every band row', () => {
    for (const z of ['day', 'week', 'month'] as const) {
      const { top, bottom } = headerBands(days, z);
      for (const row of [top, bottom]) expect(row.reduce((n, b) => n + b.span, 0)).toBe(days.length);
    }
  });

  it('rules months and quarters strongly when zoomed out', () => {
    const lines = gridLines(days, 'month');
    expect(lines.map((l) => days[l.col].slice(0, 7))).toEqual(['2026-09', '2026-10', '2026-11', '2026-12', '2027-01']);
    expect(lines.filter((l) => l.strong).map((l) => days[l.col].slice(0, 7))).toEqual(['2026-09', '2026-10', '2027-01']);
  });

  it('fits a span into the room with the widest step that holds it', () => {
    expect(zoomToFit('2026-10-05', '2026-10-30', 1200)).toBe('day');
    expect(zoomToFit('2026-10-05', '2027-02-26', 1200)).toBe('week');
    expect(zoomToFit('2026-10-05', '2028-10-30', 1200)).toBe('month');
  });
});

describe('dragging on the chart', () => {
  const scale = { start: '2026-10-05', weeks: 6 };
  const holidays = new Set(['2026-10-14']);

  it('lands a moved start on a working day, skipping a holiday column', () => {
    expect(draggedStart(scale, '2026-10-12', 2, holidays)).toBe('2026-10-15');
    expect(draggedStart(scale, '2026-10-12', 5, new Set())).toBe('2026-10-19');
  });

  it('clamps to the scale rather than running off it', () => {
    expect(dateAtColumn(scale, -10)).toBe('2026-10-05');
    expect(dateAtColumn(scale, 999)).toBe('2026-11-13');
  });

  it('never drags a finish before its start', () => {
    expect(draggedFinish(scale, '2026-10-12', '2026-10-16', -9, new Set())).toBe('2026-10-12');
    expect(draggedFinish(scale, '2026-10-12', '2026-10-16', 1, new Set())).toBe('2026-10-19');
  });

  it('turns a start into the same fields a typed start makes', () => {
    expect(startFields({ status: 'todo', actual_start: null }, '2026-10-12')).toEqual({ not_before: '2026-10-12' });
    expect(startFields({ status: 'in_progress', actual_start: '2026-10-01' }, '2026-10-12')).toEqual({ actual_start: '2026-10-12' });
  });

  it('turns a finish into a length in working days, or an actual finish when done', () => {
    expect(finishFields({ status: 'todo', duration: 3 }, '2026-10-12', '2026-10-16', holidays)).toEqual({ duration: 4 });
    expect(finishFields({ status: 'done', duration: 3 }, '2026-10-12', '2026-10-16')).toEqual({ actual_end: '2026-10-16' });
    expect(finishFields({ status: 'todo', duration: 0 }, '2026-10-12', '2026-10-16')).toEqual({ not_before: '2026-10-16' });
    expect(finishFields({ status: 'todo', duration: 3 }, '2026-10-12', '2026-10-09')).toBeNull();
  });

  it('never drags a left end past the finish', () => {
    expect(draggedStartEdge(scale, '2026-10-12', '2026-10-16', 9, new Set())).toBe('2026-10-16');
    expect(draggedStartEdge(scale, '2026-10-12', '2026-10-16', -1, new Set())).toBe('2026-10-09');
    expect(draggedStartEdge(scale, '2026-10-12', '2026-10-16', 2, holidays)).toBe('2026-10-15');
  });

  it('turns a left end into a start plus the length that keeps the finish', () => {
    // 9 Oct (Fri) to 16 Oct (Fri) is six working days; five with the holiday.
    expect(startEdgeFields({ status: 'todo', actual_start: null, duration: 3 }, '2026-10-09', '2026-10-16'))
      .toEqual({ not_before: '2026-10-09', duration: 6 });
    expect(startEdgeFields({ status: 'todo', actual_start: null, duration: 3 }, '2026-10-09', '2026-10-16', holidays))
      .toEqual({ not_before: '2026-10-09', duration: 5 });
    expect(startEdgeFields({ status: 'in_progress', actual_start: '2026-10-12', duration: 3 }, '2026-10-13', '2026-10-16'))
      .toEqual({ actual_start: '2026-10-13', duration: 4 });
    expect(startEdgeFields({ status: 'done', actual_start: '2026-10-12', actual_end: '2026-10-16', duration: 3 }, '2026-10-13', '2026-10-16'))
      .toEqual({ actual_start: '2026-10-13' });
    expect(startEdgeFields({ status: 'done', actual_start: '2026-10-12', actual_end: null, duration: 3 }, '2026-10-13', '2026-10-16'))
      .toEqual({ actual_start: '2026-10-13', duration: 4 });
    expect(startEdgeFields({ status: 'todo', actual_start: null, duration: 3 }, '2026-10-19', '2026-10-16')).toBeNull();
  });
});

describe('what the bars say', () => {
  it('counts baseline variance in working days either way', () => {
    expect(finishVariance('2026-10-09', '2026-10-13')).toBe(2);
    expect(finishVariance('2026-10-13', '2026-10-09')).toBe(-2);
    expect(finishVariance('2026-10-13', '2026-10-13')).toBe(0);
  });

  it('works progress out from status unless someone typed it', () => {
    const t = { duration: 10, actual_start: '2026-10-05' };
    expect(progressOf({ ...t, status: 'todo', progress: 30 }, '2026-10-09')).toBe(30);
    expect(progressOf({ ...t, status: 'done' }, '2026-10-09')).toBe(100);
    expect(progressOf({ ...t, status: 'in_progress' }, '2026-10-09')).toBe(50);
    expect(progressOf({ ...t, status: 'in_progress' }, '2026-12-01')).toBe(95);
    expect(progressOf({ ...t, status: 'blocked' }, '2026-10-09')).toBe(0);
    expect(rolledProgress([{ progress: 100, duration: 3 }, { progress: 0, duration: 1 }])).toBe(75);
  });

  it('traces a task’s whole chain, and not its neighbours’', () => {
    const deps = [
      { predecessor_id: 1, successor_id: 2 }, { predecessor_id: 2, successor_id: 3 },
      { predecessor_id: 4, successor_id: 3 }, { predecessor_id: 3, successor_id: 5 },
    ];
    expect([...chainOf(2, deps)].sort()).toEqual([1, 2, 3, 5]);
  });

  it('keeps a match’s summaries and hides rows under a closed one', () => {
    const rows = [{ id: 1, parent_id: null }, { id: 2, parent_id: 1 }, { id: 3, parent_id: 2 }, { id: 4, parent_id: null }];
    expect([...visibleRows(rows, (id) => id === 3, new Set())].sort()).toEqual([1, 2, 3]);
    expect([...visibleRows(rows, () => true, new Set([2]))].sort()).toEqual([1, 2, 4]);
  });
});

describe('occupancyByDay', () => {
  it('counts holders per day like occupancyOn, ignoring moments and other environments', () => {
    const b = (id: number, env: number, start: string, end: string, milestone = false) =>
      ({ id, environment_id: env, start_date: start, end_date: end, is_milestone: milestone }) as BookingView;
    const days = ['2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09'];
    const counts = occupancyByDay([
      b(1, 7, '2026-10-01', '2026-10-06'), b(2, 7, '2026-10-06', '2026-10-08'),
      b(3, 7, '2026-10-07', '2026-10-07', true), b(4, 8, '2026-10-05', '2026-10-09'),
    ], 7, days);
    expect(counts).toEqual([1, 2, 1, 1, 0]);
  });
});

describe('link types on the chart', () => {
  const p = { x0: 22, x1: 110, mid: 19, milestone: false };
  const s = { x0: 44, x1: 88, mid: 58, milestone: false };
  it('draws SS round the left into the start and FF round the right into the finish', () => {
    expect(linkPath(p, s, 'SS')).toBe('M22 19H14V58H43');
    expect(linkPath(p, s, 'FF')).toBe('M110 19H118V58H89');
  });
});

describe('rolledBaseline', () => {
  it('gives a summary its tasks’ earliest start and latest finish, and none when they have none', () => {
    const tasks = [
      { id: 10, sort_order: 0 }, { id: 1, sort_order: 1, parent_id: 10 }, { id: 2, sort_order: 2, parent_id: 10 },
      { id: 20, sort_order: 3 }, { id: 3, sort_order: 4, parent_id: 20 },
    ];
    const saved = new Map([
      [1, { start: '2026-03-02', end: '2026-03-04' }],
      [2, { start: '2026-03-05', end: '2026-03-10' }],
      [20, { start: '2026-01-01', end: '2026-01-02' }],
    ]);
    const out = rolledBaseline(tasks, saved);
    expect(out.get(10)).toEqual({ start: '2026-03-02', end: '2026-03-10' });
    expect(out.has(20)).toBe(false);
    expect(out.get(1)).toEqual(saved.get(1));
  });
});
