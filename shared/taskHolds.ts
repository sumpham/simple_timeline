import { addDays, addWorkingDays, maxDate, minDate, overlapDays, diffDays, type HolidaySet } from './dates.ts';
import type { BookingKind, EnvKind, ISODate, Task, TaskHold } from './types.ts';

/**
 * How tasks book environments.
 *
 * A project's tasks on one environment form holds: stretches of calendar time
 * the environment is needed. Tasks merge into one hold while the gap between
 * them is at most `HOLD_GAP_DAYS` working days; a longer gap frees the
 * environment in between, so someone else can use it.
 *
 * A hold then meets the bookings people made by hand, and the longer one wins:
 * a manual booking overlapped by a hold stretches over it and never shrinks below
 * what was booked; a hold that overlaps no manual booking becomes an auto booking
 * that follows its tasks wherever they go.
 *
 * Holds count calendar days like every booking, because conflict detection does.
 */

export const HOLD_GAP_DAYS = 2;

type Span = { start: ISODate; end: ISODate };

/** A task's calendar span on the plan: what happened if it is done, else what is scheduled. */
export function taskSpan(t: Pick<Task, 'status' | 'actual_start' | 'actual_end' | 'start_date' | 'end_date'>): Span | null {
  if (t.status === 'done' && t.actual_start && t.actual_end) return { start: t.actual_start, end: t.actual_end };
  if (!t.start_date || !t.end_date) return null;
  return { start: t.status !== 'todo' && t.actual_start ? t.actual_start : t.start_date, end: t.end_date };
}

export function taskHolds(
  tasks: readonly Pick<Task, 'id' | 'project_id' | 'environment_id' | 'duration' | 'status' | 'actual_start' | 'actual_end' | 'start_date' | 'end_date'>[],
  holidays?: HolidaySet,
): TaskHold[] {
  const byEnv = new Map<number, { id: number; span: Span; done: boolean; project_id: number }[]>();
  for (const t of tasks) {
    // A milestone is a moment, not occupancy, the same as a one-day booking.
    if (t.environment_id == null || t.duration <= 0) continue;
    const span = taskSpan(t);
    if (!span) continue;
    const list = byEnv.get(t.environment_id) ?? byEnv.set(t.environment_id, []).get(t.environment_id)!;
    list.push({ id: t.id, span, done: t.status === 'done', project_id: t.project_id });
  }

  const holds: TaskHold[] = [];
  for (const [envId, list] of byEnv) {
    list.sort((a, b) => a.span.start.localeCompare(b.span.start) || a.id - b.id);
    let cur: TaskHold | null = null;
    for (const t of list) {
      // Merge while the next task starts within the gap allowance of this hold's end.
      if (cur && t.span.start <= addWorkingDays(cur.end, HOLD_GAP_DAYS + 1, holidays)) {
        cur.end = maxDate(cur.end, t.span.end);
        cur.task_ids.push(t.id);
        cur.done = cur.done && t.done;
        continue;
      }
      if (cur) holds.push(cur);
      cur = { project_id: t.project_id, environment_id: envId, start: t.span.start, end: t.span.end, task_ids: [t.id], done: t.done };
    }
    if (cur) holds.push(cur);
  }
  return holds.sort((a, b) => a.environment_id - b.environment_id || a.start.localeCompare(b.start));
}

/** The longer wins: a manual span stretched over whatever its tasks need. */
export function effectiveSpan(manual: Span | null, hold: Span | null): Span | null {
  if (!manual) return hold;
  if (!hold) return manual;
  return { start: minDate(manual.start, hold.start), end: maxDate(manual.end, hold.end) };
}

/**
 * The day the environment could be handed back: every task in the hold is done
 * and the booking runs on past the last of them. Null otherwise.
 */
export function releaseFrom(bookingEnd: ISODate, hold: Pick<TaskHold, 'end' | 'done'> | null): ISODate | null {
  if (!hold || !hold.done || bookingEnd <= hold.end) return null;
  return addDays(hold.end, 1);
}

export type ReconcileBooking = {
  id: number;
  environment_id: number;
  start_date: ISODate;
  end_date: ISODate;
  manual_start: ISODate | null;
  manual_end: ISODate | null;
  hold_start?: ISODate | null;
  hold_end?: ISODate | null;
  hold_done?: number | null;
};

/** One booking as the plan wants it. `id` null means it is new. */
export type DesiredBooking = {
  id: number | null;
  environment_id: number;
  start_date: ISODate;
  end_date: ISODate;
  manual_start: ISODate | null;
  manual_end: ISODate | null;
  hold_start: ISODate | null;
  hold_end: ISODate | null;
  hold_done: number;
  task_ids: number[];
};

export type Reconciliation = {
  /** Every booking of the project after the change, including unchanged ones. */
  bookings: DesiredBooking[];
  create: DesiredBooking[];
  update: DesiredBooking[];
  remove: number[];
};

/**
 * Bring one project's bookings into line with its task holds.
 *
 * Auto bookings are matched to the holds they served before by largest overlap,
 * then nearest start, so a booking keeps its id as its tasks move. That keeps any
 * accepted double-booking keyed on it (see `conflictKey`) pointing at the same thing.
 */
export function reconcileBookings(bookings: readonly ReconcileBooking[], holds: readonly TaskHold[]): Reconciliation {
  const manual = bookings.filter((b) => b.manual_start != null && b.manual_end != null);
  const autos = bookings.filter((b) => b.manual_start == null || b.manual_end == null);

  // Each hold attaches to the manual booking it overlaps most; ties go to the older booking.
  const absorbed = new Map<number, TaskHold[]>();
  const loose: TaskHold[] = [];
  for (const h of holds) {
    let best: ReconcileBooking | null = null;
    let bestOverlap = 0;
    for (const b of manual) {
      if (b.environment_id !== h.environment_id) continue;
      const o = overlapDays(b.manual_start!, b.manual_end!, h.start, h.end);
      if (o > bestOverlap || (o === bestOverlap && o > 0 && best && b.id < best.id)) {
        best = b;
        bestOverlap = o;
      }
    }
    if (best) (absorbed.get(best.id) ?? absorbed.set(best.id, []).get(best.id)!).push(h);
    else loose.push(h);
  }

  const desired: DesiredBooking[] = [];

  for (const b of manual) {
    const hs = absorbed.get(b.id) ?? [];
    const hold = hs.length ? mergeHolds(hs) : null;
    const span = effectiveSpan({ start: b.manual_start!, end: b.manual_end! }, hold)!;
    desired.push({
      id: b.id,
      environment_id: b.environment_id,
      start_date: span.start,
      end_date: span.end,
      manual_start: b.manual_start,
      manual_end: b.manual_end,
      hold_start: hold?.start ?? null,
      hold_end: hold?.end ?? null,
      hold_done: hold?.done ? 1 : 0,
      task_ids: hold?.task_ids ?? [],
    });
  }

  const unused = new Set(autos);
  for (const h of loose) {
    let pick: ReconcileBooking | null = null;
    let score = -Infinity;
    for (const b of unused) {
      if (b.environment_id !== h.environment_id) continue;
      const o = overlapDays(b.start_date, b.end_date, h.start, h.end);
      // Overlap first; otherwise the closest start. Both favour keeping an id.
      const s = o > 0 ? o * 1e6 : -Math.abs(diffDays(b.start_date, h.start));
      if (s > score) {
        score = s;
        pick = b;
      }
    }
    if (pick) unused.delete(pick);
    desired.push({
      id: pick?.id ?? null,
      environment_id: h.environment_id,
      start_date: h.start,
      end_date: h.end,
      manual_start: null,
      manual_end: null,
      hold_start: h.start,
      hold_end: h.end,
      hold_done: h.done ? 1 : 0,
      task_ids: h.task_ids,
    });
  }

  const before = new Map(bookings.map((b) => [b.id, b]));
  const update = desired.filter((d) => {
    if (d.id == null) return false;
    const b = before.get(d.id)!;
    return b.start_date !== d.start_date || b.end_date !== d.end_date
      || (b.hold_start ?? null) !== d.hold_start || (b.hold_end ?? null) !== d.hold_end
      || (b.hold_done ?? 0) !== d.hold_done;
  });

  return {
    bookings: desired,
    create: desired.filter((d) => d.id == null),
    update,
    remove: [...unused].map((b) => b.id),
  };
}

function mergeHolds(hs: readonly TaskHold[]): TaskHold {
  return hs.reduce((acc, h) => ({
    ...acc,
    start: minDate(acc.start, h.start),
    end: maxDate(acc.end, h.end),
    task_ids: [...acc.task_ids, ...h.task_ids],
    done: acc.done && h.done,
  }));
}

/** The booking kind a task-made booking gets, from the environment it holds. */
export function autoBookingKind(envKind: EnvKind): BookingKind {
  return envKind === 'PROD' || envKind === 'OTHER' ? 'CUSTOM' : envKind;
}
