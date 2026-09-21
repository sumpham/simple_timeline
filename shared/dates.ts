import type { ISODate } from './types.ts';

/**
 * Date-only arithmetic on `YYYY-MM-DD` strings.
 *
 * Everything here works in UTC deliberately. A plan date is a label on a calendar,
 * not an instant, so it must not shift when the viewer's timezone does.
 */

const MS_PER_DAY = 86_400_000;

export function toUTC(d: ISODate): number {
  const [y, m, day] = d.split('-').map(Number);
  return Date.UTC(y, m - 1, day);
}

export function fromUTC(ms: number): ISODate {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(d: ISODate, n: number): ISODate {
  return fromUTC(toUTC(d) + n * MS_PER_DAY);
}

/** Calendar days from a to b. Negative when b is before a. */
export function diffDays(a: ISODate, b: ISODate): number {
  return Math.round((toUTC(b) - toUTC(a)) / MS_PER_DAY);
}

/** Inclusive calendar span, so a single-day booking is 1. */
export function calendarDays(start: ISODate, end: ISODate): number {
  return diffDays(start, end) + 1;
}

export function isValidISODate(d: unknown): d is ISODate {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;
  return fromUTC(toUTC(d)) === d; // rejects 2025-02-30 and friends
}

export function today(): ISODate {
  return fromUTC(Date.now());
}

/** 0 = Sunday .. 6 = Saturday */
export function dayOfWeek(d: ISODate): number {
  return new Date(toUTC(d)).getUTCDay();
}

export function isWeekend(d: ISODate): boolean {
  const w = dayOfWeek(d);
  return w === 0 || w === 6;
}

export type HolidaySet = ReadonlySet<ISODate>;

export function isWorkingDay(d: ISODate, holidays: HolidaySet = new Set()): boolean {
  return !isWeekend(d) && !holidays.has(d);
}

/**
 * Effort in working days, inclusive of both ends.
 *
 * This is deliberately NOT the same as the span the environment is held for --
 * see `calendarDays`. A Fri-to-Mon booking is 2 working days of effort but holds
 * the environment for 4 calendar days, and conflict detection uses the latter.
 */
export function workingDays(start: ISODate, end: ISODate, holidays: HolidaySet = new Set()): number {
  if (diffDays(start, end) < 0) return 0;
  let count = 0;
  for (let d = start; diffDays(d, end) >= 0; d = addDays(d, 1)) {
    if (isWorkingDay(d, holidays)) count++;
  }
  return count;
}

/**
 * Nearest working day at or after `d` (or at or before, when direction is -1).
 * Used to snap bookings off weekends and holidays.
 */
export function snapToWorkingDay(d: ISODate, holidays: HolidaySet = new Set(), direction: 1 | -1 = 1): ISODate {
  let cur = d;
  // A run of non-working days is never longer than a couple of weeks in practice;
  // the bound just stops a malformed holiday table from spinning forever.
  for (let i = 0; i < 366; i++) {
    if (isWorkingDay(cur, holidays)) return cur;
    cur = addDays(cur, direction);
  }
  return d;
}

/** Shift a date by n working days, skipping weekends and holidays. */
export function addWorkingDays(d: ISODate, n: number, holidays: HolidaySet = new Set()): ISODate {
  if (n === 0) return snapToWorkingDay(d, holidays);
  const step = n > 0 ? 1 : -1;
  let remaining = Math.abs(n);
  let cur = d;
  // Bounded so a pathological holiday table cannot spin forever. Ten calendar
  // days per working day is far past any real calendar.
  const limit = Math.abs(n) * 10 + 366;
  for (let guard = 0; guard < limit && remaining > 0; guard++) {
    cur = addDays(cur, step);
    if (isWorkingDay(cur, holidays)) remaining--;
  }
  return cur;
}

/** Inclusive overlap of two calendar ranges, in days. 0 when they do not touch. */
export function overlapDays(aStart: ISODate, aEnd: ISODate, bStart: ISODate, bEnd: ISODate): number {
  const start = Math.max(toUTC(aStart), toUTC(bStart));
  const end = Math.min(toUTC(aEnd), toUTC(bEnd));
  if (end < start) return 0;
  return Math.round((end - start) / MS_PER_DAY) + 1;
}

export function minDate(a: ISODate, b: ISODate): ISODate {
  return toUTC(a) <= toUTC(b) ? a : b;
}

export function maxDate(a: ISODate, b: ISODate): ISODate {
  return toUTC(a) >= toUTC(b) ? a : b;
}

export function startOfMonth(d: ISODate): ISODate {
  return `${d.slice(0, 7)}-01`;
}

export function startOfWeek(d: ISODate): ISODate {
  // Weeks start Monday; a plan week that starts on Sunday reads wrong to everyone.
  const shift = (dayOfWeek(d) + 6) % 7;
  return addDays(d, -shift);
}

/**
 * Shift by whole months, clamping the day to the target month's length so
 * 31 Jan + 1 month is 28/29 Feb rather than spilling into March.
 */
export function addMonths(d: ISODate, n: number): ISODate {
  const year = Number(d.slice(0, 4));
  const month = Number(d.slice(5, 7));
  const day = Number(d.slice(8, 10));

  const total = year * 12 + (month - 1) + n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12 + 12) % 12 + 1;
  const lastDay = new Date(Date.UTC(ny, nm, 0)).getUTCDate();

  return `${String(ny).padStart(4, '0')}-${String(nm).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function startOfQuarter(d: ISODate): ISODate {
  const month = Number(d.slice(5, 7));
  const qStart = Math.floor((month - 1) / 3) * 3 + 1;
  return `${d.slice(0, 4)}-${String(qStart).padStart(2, '0')}-01`;
}
