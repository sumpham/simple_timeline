import { addDays, workingDays, type HolidaySet } from './dates.ts';
import type { ISODate } from './types.ts';

/**
 * How far the plan has moved from a baseline (reqs/pm_features.md §4.4): the one
 * rule for variance, read by the table's variance columns, the chart's label and
 * the slip chart, so they never disagree. Working days, the effort rule: a task
 * that moves from Friday to Monday has slipped one day, not three.
 */

/** Signed working days from `a` to `b`: positive when `b` is later. */
export function workingShift(a: ISODate, b: ISODate, holidays?: HolidaySet): number {
  if (a === b) return 0;
  return a < b ? workingDays(addDays(a, 1), b, holidays) : -workingDays(addDays(b, 1), a, holidays);
}

export type Variance = {
  /** Working days later (positive) or sooner (negative) than the baseline. */
  start: number;
  finish: number;
  /** Working days longer or shorter; null when the baseline did not keep a length. */
  duration: number | null;
};

/** A task's variance against its baseline snapshot. */
export function varianceOf(
  now: { start: ISODate; end: ISODate; duration?: number | null },
  saved: { start: ISODate; end: ISODate; duration?: number | null },
  holidays?: HolidaySet,
): Variance {
  return {
    start: workingShift(saved.start, now.start, holidays),
    finish: workingShift(saved.end, now.end, holidays),
    duration: now.duration != null && saved.duration != null ? now.duration - saved.duration : null,
  };
}

/** `+3d`, `−2d` (a true minus) or `0d`: how a variance reads in a cell or a label. */
export function formatShift(n: number): string {
  return n === 0 ? '0d' : `${n > 0 ? '+' : '−'}${Math.abs(n)}d`;
}
