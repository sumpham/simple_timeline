import { addDays, addWorkingDays, diffDays, isWorkingDay, snapToWorkingDay, workingDays, type HolidaySet } from './dates.ts';
import type { ISODate, Task, TaskDependency, TaskSchedule } from './types.ts';

/**
 * Critical-path scheduling over one project's tasks.
 *
 * Dates are never typed for a task: they fall out of its duration, its
 * predecessors and an optional "start no earlier than". The arithmetic runs on
 * working-day indexes counted from the project start, so durations and lags skip
 * weekends and holidays (the effort rule) and the passes are plain integer maths.
 *
 * A task occupies the half-open index range [start, start + duration). A
 * successor may start at its predecessor's exclusive finish plus the lag. A
 * milestone (duration 0) sits at the end of the day before its index, which is
 * where a finish milestone belongs: on its predecessor's last day.
 */

export type ScheduleInput = {
  tasks: readonly Pick<Task, 'id' | 'duration' | 'status' | 'not_before' | 'actual_start' | 'actual_end'>[];
  deps: readonly TaskDependency[];
  projectStart: ISODate;
  holidays?: HolidaySet;
};

export type ScheduleResult = {
  tasks: Map<number, TaskSchedule>;
  start: ISODate;
  finish: ISODate;
  /** Critical tasks in schedule order. */
  critical_path: number[];
  /** Task ids in dependency order; predecessors always come first. */
  order: number[];
};

export type ScheduleFailure = { cycle: number[] };

/** Working-day index <-> date, anchored on the project start. Cached, since passes ask repeatedly. */
function calendar(projectStart: ISODate, holidays: HolidaySet) {
  const base = snapToWorkingDay(projectStart, holidays);
  const dates = new Map<number, ISODate>();

  const dateOf = (i: number): ISODate => {
    let d = dates.get(i);
    if (d == null) {
      d = addWorkingDays(base, i, holidays);
      dates.set(i, d);
    }
    return d;
  };

  /** Index of the working day at or after `d`. */
  const indexOf = (d: ISODate): number => {
    const snapped = snapToWorkingDay(d, holidays);
    const days = diffDays(base, snapped);
    if (days >= 0) return workingDays(base, snapped, holidays) - 1;
    return -(workingDays(snapped, addDays(base, -1), holidays));
  };

  return { base, dateOf, indexOf };
}

export function scheduleProject(input: ScheduleInput): ScheduleResult | ScheduleFailure {
  const holidays = input.holidays ?? new Set<ISODate>();
  const cal = calendar(input.projectStart, holidays);
  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const deps = input.deps.filter((d) => byId.has(d.predecessor_id) && byId.has(d.successor_id));

  const order = topologicalOrder([...byId.keys()], deps);
  if ('cycle' in order) return order;

  const preds = new Map<number, TaskDependency[]>();
  const succs = new Map<number, TaskDependency[]>();
  for (const d of deps) {
    (preds.get(d.successor_id) ?? preds.set(d.successor_id, []).get(d.successor_id)!).push(d);
    (succs.get(d.predecessor_id) ?? succs.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d);
  }

  // Forward pass: early start and exclusive early finish, as indexes.
  const es = new Map<number, number>();
  const ef = new Map<number, number>();
  for (const id of order.order) {
    const t = byId.get(id)!;
    const duration = Math.max(0, t.duration);

    // What has happened is not rescheduled: a done task sits on its actual dates,
    // a started one keeps its actual start.
    if (t.status === 'done' && t.actual_start && t.actual_end) {
      const s = cal.indexOf(t.actual_start);
      es.set(id, s);
      ef.set(id, Math.max(s, cal.indexOf(t.actual_end) + 1));
      continue;
    }
    if ((t.status === 'in_progress' || t.status === 'done') && t.actual_start) {
      const s = cal.indexOf(t.actual_start);
      es.set(id, s);
      ef.set(id, s + duration);
      continue;
    }

    let start = 0;
    for (const d of preds.get(id) ?? []) start = Math.max(start, ef.get(d.predecessor_id)! + d.lag);
    if (t.not_before) {
      // A milestone's date is the day before its index, so its floor moves up one.
      start = Math.max(start, cal.indexOf(t.not_before) + (duration === 0 ? 1 : 0));
    }
    es.set(id, start);
    ef.set(id, start + duration);
  }

  const finishIndex = Math.max(0, ...ef.values());

  // Backward pass: late finish and late start.
  const lf = new Map<number, number>();
  const ls = new Map<number, number>();
  for (let i = order.order.length - 1; i >= 0; i--) {
    const id = order.order[i];
    let finish = finishIndex;
    for (const d of succs.get(id) ?? []) finish = Math.min(finish, ls.get(d.successor_id)! - d.lag);
    lf.set(id, finish);
    ls.set(id, finish - (ef.get(id)! - es.get(id)!));
  }

  const tasks = new Map<number, TaskSchedule>();
  for (const id of order.order) {
    const t = byId.get(id)!;
    const start = es.get(id)!;
    const finish = ef.get(id)!;
    const total = ls.get(id)! - start;
    let free = finishIndex - finish;
    for (const d of succs.get(id) ?? []) free = Math.min(free, es.get(d.successor_id)! - d.lag - finish);

    tasks.set(id, {
      id,
      ...span(cal.dateOf, start, finish),
      late_start: span(cal.dateOf, ls.get(id)!, lf.get(id)!).start,
      late_end: span(cal.dateOf, ls.get(id)!, lf.get(id)!).end,
      total_float: total,
      free_float: Math.max(0, free),
      // Done work cannot hold the project up any more, whatever its float says.
      critical: total <= 0 && t.status !== 'done',
    });
  }

  const critical_path = order.order
    .filter((id) => tasks.get(id)!.critical)
    .sort((a, b) => es.get(a)! - es.get(b)! || ef.get(a)! - ef.get(b)! || a - b);

  const all = [...tasks.values()];
  return {
    tasks,
    start: all.length ? all.reduce((m, t) => (t.start < m ? t.start : m), all[0].start) : cal.base,
    finish: all.length ? all.reduce((m, t) => (t.end > m ? t.end : m), all[0].end) : cal.base,
    critical_path,
    order: order.order,
  };
}

/** Dates for the half-open index range [start, finish). A milestone is the day before its index. */
function span(dateOf: (i: number) => ISODate, start: number, finish: number): { start: ISODate; end: ISODate } {
  if (finish <= start) {
    const at = dateOf(start > 0 ? start - 1 : start);
    return { start: at, end: at };
  }
  return { start: dateOf(start), end: dateOf(finish - 1) };
}

/** Kahn's algorithm. Ties go to the lower id so the order is stable. */
export function topologicalOrder(
  ids: readonly number[],
  deps: readonly TaskDependency[],
): { order: number[] } | ScheduleFailure {
  const indegree = new Map(ids.map((id) => [id, 0]));
  const out = new Map<number, number[]>();
  for (const d of deps) {
    if (!indegree.has(d.predecessor_id) || !indegree.has(d.successor_id)) continue;
    indegree.set(d.successor_id, indegree.get(d.successor_id)! + 1);
    (out.get(d.predecessor_id) ?? out.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d.successor_id);
  }

  const ready = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const next of out.get(id) ?? []) {
      const n = indegree.get(next)! - 1;
      indegree.set(next, n);
      if (n === 0) {
        ready.push(next);
        ready.sort((a, b) => a - b);
      }
    }
  }

  if (order.length === ids.length) return { order };
  const stuck = ids.filter((id) => !order.includes(id));
  return { cycle: findCycle(stuck, deps) ?? stuck };
}

/**
 * The loop a new link `pred -> succ` would close, as ids from `succ` round to
 * `succ` again; null when the link is safe. Used to refuse the link by name.
 */
export function cycleWith(
  deps: readonly TaskDependency[],
  predecessorId: number,
  successorId: number,
): number[] | null {
  if (predecessorId === successorId) return [successorId, successorId];
  const out = new Map<number, number[]>();
  for (const d of deps) (out.get(d.predecessor_id) ?? out.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d.successor_id);

  // Breadth-first from the successor: reaching the predecessor means a loop.
  const from = new Map<number, number>();
  const queue = [successorId];
  const seen = new Set(queue);
  while (queue.length) {
    const id = queue.shift()!;
    if (id === predecessorId) {
      const path = [id];
      for (let cur = id; cur !== successorId;) {
        cur = from.get(cur)!;
        path.unshift(cur);
      }
      return [...path, successorId];
    }
    for (const next of out.get(id) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        from.set(next, id);
        queue.push(next);
      }
    }
  }
  return null;
}

function findCycle(ids: readonly number[], deps: readonly TaskDependency[]): number[] | null {
  const inSet = new Set(ids);
  for (const d of deps) {
    if (!inSet.has(d.predecessor_id) || !inSet.has(d.successor_id)) continue;
    const rest = deps.filter((x) => x !== d);
    const loop = cycleWith(rest, d.predecessor_id, d.successor_id);
    if (loop) return loop;
  }
  return null;
}

/** Working days a finish runs past its target; 0 when on time or there is no target. */
export function lateBy(finish: ISODate | null | undefined, target: ISODate | null | undefined, holidays?: HolidaySet): number {
  if (!finish || !target || finish <= target) return 0;
  return workingDays(addDays(target, 1), finish, holidays);
}

/** Where a new plan starts when the project has none yet: the next working day. */
export function defaultProjectStart(day: ISODate, holidays?: HolidaySet): ISODate {
  return isWorkingDay(day, holidays) ? day : snapToWorkingDay(day, holidays);
}
