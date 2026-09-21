import { addDays, addWorkingDays, diffDays, snapToWorkingDay, workingDays, type HolidaySet } from '../shared/dates.ts';
import type { BookingView, ISODate } from '../shared/types.ts';

/**
 * Where a dragged booking lands.
 *
 * Every result sits on working days at both ends, which matters for more than
 * tidiness: the server snaps on save, so a preview that ignored working days
 * would jump on drop. Snapping here makes the server's snap a no-op, and what
 * you see while dragging is what gets written.
 */
export type Span = { start: ISODate; end: ISODate };

/**
 * Move the whole booking. Effort is measured in working days, so a five-working-day
 * booking stays five working days wherever it lands — dragging it across a weekend
 * must not silently make it longer or shorter.
 */
export function moveBooking(booking: BookingView, deltaDays: number, holidays: HolidaySet): Span {
  const start = snapToWorkingDay(addDays(booking.start_date, deltaDays), holidays, deltaDays < 0 ? -1 : 1);
  if (booking.is_milestone) return { start, end: start };

  const length = Math.max(1, workingDays(booking.start_date, booking.end_date, holidays));
  return { start, end: addWorkingDays(start, length - 1, holidays) };
}

/** Drag the left edge. The right edge stays put and the booking cannot invert. */
export function resizeStart(booking: BookingView, deltaDays: number, holidays: HolidaySet): Span {
  const end = booking.end_date;
  let start = snapToWorkingDay(addDays(booking.start_date, deltaDays), holidays, deltaDays < 0 ? -1 : 1);
  if (diffDays(start, end) < 0) start = snapToWorkingDay(end, holidays, -1);
  return { start, end };
}

/** Drag the right edge. The left edge stays put and the booking cannot invert. */
export function resizeEnd(booking: BookingView, deltaDays: number, holidays: HolidaySet): Span {
  const start = booking.start_date;
  let end = snapToWorkingDay(addDays(booking.end_date, deltaDays), holidays, deltaDays < 0 ? -1 : 1);
  if (diffDays(start, end) < 0) end = snapToWorkingDay(start, holidays, 1);
  return { start, end };
}

export type DragMode = 'move' | 'resize-start' | 'resize-end';

export function applyDrag(
  booking: BookingView,
  mode: DragMode,
  deltaDays: number,
  holidays: HolidaySet,
): Span {
  if (mode === 'resize-start') return resizeStart(booking, deltaDays, holidays);
  if (mode === 'resize-end') return resizeEnd(booking, deltaDays, holidays);
  return moveBooking(booking, deltaDays, holidays);
}

/** A booking rewritten to a new span, with its derived day counts kept honest. */
export function withSpan(booking: BookingView, span: Span, holidays: HolidaySet): BookingView {
  return {
    ...booking,
    start_date: span.start,
    end_date: span.end,
    calendar_days: diffDays(span.start, span.end) + 1,
    working_days: workingDays(span.start, span.end, holidays),
  };
}

export function sameSpan(a: Span, b: { start_date: ISODate; end_date: ISODate }): boolean {
  return a.start === b.start_date && a.end === b.end_date;
}
