import { describe, expect, it } from 'vitest';
import { dayColumn, ganttDays, ganttScale, GANTT_DAY, GANTT_MIN_WEEKS, spanX } from '../client/gantt.ts';
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
