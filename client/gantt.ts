import type { ISODate } from '../shared/types.ts';
import { addDays, dayOfWeek, diffDays, maxDate, minDate, startOfWeek } from '../shared/dates.ts';

/**
 * The plan's Gantt scale: working weeks, Monday to Friday, one column a day.
 * Task spans are working days, so weekends would only be empty stripes; they
 * are left out and a Friday bar meets the Monday bar that follows it.
 * Holidays are real weekdays and keep their column, shaded.
 */

export const GANTT_DAY = 22;
export const GANTT_WEEK = GANTT_DAY * 5;
/** Enough weeks that a short plan still reads as a chart, not a stub. */
export const GANTT_MIN_WEEKS = 8;
/** Never draw more than this, whatever the dates say. */
const MAX_WEEKS = 520;

export type GanttScale = {
  /** A Monday. */
  start: ISODate;
  weeks: number;
};

export function ganttScale(dates: readonly (ISODate | null | undefined)[], minWeeks = GANTT_MIN_WEEKS): GanttScale | null {
  let lo: ISODate | null = null;
  let hi: ISODate | null = null;
  for (const d of dates) {
    if (!d) continue;
    lo = lo ? minDate(lo, d) : d;
    hi = hi ? maxDate(hi, d) : d;
  }
  if (!lo || !hi) return null;
  const start = startOfWeek(lo);
  // One spare week after the last date, so the finish never sits on the edge.
  const needed = Math.floor(diffDays(start, startOfWeek(hi)) / 7) + 2;
  return { start, weeks: Math.min(MAX_WEEKS, Math.max(minWeeks, needed)) };
}

/**
 * The weekday column holding a date. A weekend date has no column: as a start
 * it moves on to Monday, as an end it moves back to Friday.
 */
export function dayColumn(scale: GanttScale, d: ISODate, edge: 'start' | 'end'): number {
  const days = diffDays(scale.start, d);
  let week = Math.floor(days / 7);
  let dow = (dayOfWeek(d) + 6) % 7; // Monday 0 .. Sunday 6
  if (dow >= 5) {
    if (edge === 'start') { week += 1; dow = 0; } else dow = 4;
  }
  return week * 5 + dow;
}

/** Left and right edges of a span, in pixels; the end day is included. */
export function spanX(scale: GanttScale, start: ISODate, end: ISODate, day = GANTT_DAY): { x0: number; x1: number } {
  const x0 = dayColumn(scale, start, 'start') * day;
  const x1 = (dayColumn(scale, end, 'end') + 1) * day;
  return { x0, x1: Math.max(x0, x1) };
}

/** The date in each column, Mondays first, for the header and the shading. */
export function ganttDays(scale: GanttScale): ISODate[] {
  const out: ISODate[] = [];
  for (let w = 0; w < scale.weeks; w++) {
    const monday = addDays(scale.start, w * 7);
    for (let i = 0; i < 5; i++) out.push(addDays(monday, i));
  }
  return out;
}
