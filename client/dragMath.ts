import {
  addDays, addWorkingDays, dayOfWeek, diffDays, snapToWorkingDay, workingDays, type HolidaySet,
} from '../shared/dates.ts';
import type { BookingKind, BookingView, EnvKind, Environment, ISODate, Project } from '../shared/types.ts';

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

/**
 * The span a click on an empty lane books: from the clicked day to the Friday of
 * that week. A click on a weekend or holiday starts on the next working day, so a
 * Saturday click books the whole of the following week. Both ends land on working
 * days, like every drag result, so the server's snap leaves it alone.
 */
export function quickSpan(clicked: ISODate, holidays: HolidaySet): Span {
  const start = snapToWorkingDay(clicked, holidays, 1);
  const friday = addDays(start, 5 - dayOfWeek(start));
  let end = snapToWorkingDay(friday, holidays, -1);
  if (diffDays(start, end) < 0) end = start;
  return { start, end };
}

/** The booking kind an environment implies. PROD takes releases; OTHER has no kind of its own. */
export function bookingKindFor(env: EnvKind): BookingKind {
  if (env === 'PROD') return 'RELEASE';
  if (env === 'OTHER') return 'CUSTOM';
  return env;
}

/** What a long press on a lane will book, worked out before anything is saved. */
export type QuickPlan = { project: Project; env: Environment; kind: BookingKind; span: Span };

/** Stands in for a booking the server has not confirmed yet. Real ids are positive. */
export const PROVISIONAL_ID = -1;

/**
 * The booking a plan will become, drawn on the board while the save is in flight.
 * It goes through the same packing and conflict engine as a real one, so the bar
 * appears at once, in its final lane, and any double-booking it makes shows too.
 */
export function provisionalBooking(plan: QuickPlan, holidays: HolidaySet): BookingView {
  const { project, env, kind } = plan;
  const span = kind === 'RELEASE' ? { start: plan.span.start, end: plan.span.start } : plan.span;
  return withSpan({
    id: PROVISIONAL_ID,
    project_id: project.id,
    environment_id: env.id,
    kind,
    start_date: span.start,
    end_date: span.end,
    confidence: 'committed',
    optional: 0,
    note: null,
    marker: null,
    project_name: project.name,
    team_id: project.team_id,
    priority: project.priority,
    env_name: env.name,
    env_kind: env.kind,
    capacity: env.capacity,
    calendar_days: 0,
    working_days: 0,
    is_milestone: kind === 'RELEASE' || span.start === span.end,
  }, span, holidays);
}
