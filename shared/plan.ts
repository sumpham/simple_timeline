import { applyResolutions, detectConflicts, openConflicts } from './conflicts.ts';
import { calendarDays, diffDays, type HolidaySet } from './dates.ts';
import { lateBy, scheduleProject, type ScheduleResult } from './schedule.ts';
import { leavesOf, rolledUp } from './wbs.ts';
import { reconcileBookings, taskHolds, type Reconciliation, type ReconcileBooking } from './taskHolds.ts';
import type {
  BookingView, Conflict, Environment, ISODate, PlanImpact, PlanRisk, Task, TaskDependency, TaskHold,
} from './types.ts';

/**
 * One project's plan, end to end: schedule the tasks, find the holds they make,
 * and work out what the project's bookings must become. Pure, so the server runs
 * it to write and the preview endpoint runs it to predict, and the two agree.
 */

export type PlanInput = {
  projectStart: ISODate;
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
  bookings: readonly ReconcileBooking[];
  holidays?: HolidaySet;
};

export type PlanOutcome = {
  schedule: ScheduleResult;
  deps: readonly TaskDependency[];
  /** The tasks with their scheduled fields filled in. */
  tasks: Task[];
  holds: TaskHold[];
  reconciliation: Reconciliation;
};

export function planProject(input: PlanInput): PlanOutcome | { cycle: number[] } {
  const schedule = scheduleProject({
    tasks: input.tasks, deps: input.deps, projectStart: input.projectStart, holidays: input.holidays,
  });
  if ('cycle' in schedule) return schedule;

  const byId = new Map(input.tasks.map((t) => [t.id, t]));
  const tasks = input.tasks.map((t) => {
    const s = schedule.tasks.get(t.id)!;
    const dated = { ...t, start_date: s.start, end_date: s.end, total_float: s.total_float, critical: s.critical ? 1 : 0 };
    // A summary has no status or actuals of its own: they are its tasks', rolled up.
    return s.summary ? { ...dated, ...rolledUp(leavesOf(input.tasks, t.id).map((id) => byId.get(id)!)) } : dated;
  });
  // A summary is a roll-up, not work: it never books an environment itself.
  const holds = taskHolds(tasks.filter((t) => !schedule.tasks.get(t.id)!.summary), input.holidays);
  return { schedule, deps: input.deps, tasks, holds, reconciliation: reconcileBookings(input.bookings, holds) };
}

export type ImpactContext = {
  project: { id: number; name: string; priority: BookingView['priority']; target_date?: ISODate | null };
  /** Every booking of the team, this project's included, over all time. */
  teamBookings: readonly BookingView[];
  environments: readonly Environment[];
  resolved: ReadonlySet<string>;
  holidays?: HolidaySet;
  /** The tasks being deleted, when the change is a delete: one, or a summary with its branch. */
  deletedTaskIds?: readonly number[];
};

/** What changing a plan from `before` to `after` would do, and how risky that is. */
export function planImpact(before: PlanOutcome, after: PlanOutcome | { cycle: number[] }, ctx: ImpactContext): PlanImpact {
  const names = new Map(before.tasks.map((t) => [t.id, t.name]));
  const finishBefore = before.tasks.length ? before.schedule.finish : null;

  if ('cycle' in after) {
    return {
      ...emptyImpact(finishBefore),
      risk: 'high',
      cycle: after.cycle.map((id) => names.get(id) ?? `#${id}`),
    };
  }
  for (const t of after.tasks) names.set(t.id, t.name);

  const beforeTasks = new Map(before.tasks.map((t) => [t.id, t]));
  const afterTasks = new Map(after.tasks.map((t) => [t.id, t]));

  const moved: PlanImpact['moved'] = [];
  for (const t of after.tasks) {
    const b = beforeTasks.get(t.id);
    if (!b?.start_date || !t.start_date || b.start_date === t.start_date) continue;
    moved.push({ id: t.id, name: t.name, days: diffDays(b.start_date, t.start_date) });
  }

  const deleted = new Set(ctx.deletedTaskIds ?? []);
  // Successors that lose a predecessor when tasks go, whether or not the chain is kept.
  const unlinked = [...new Map(before.deps
    .filter((d) => deleted.has(d.predecessor_id) && afterTasks.has(d.successor_id))
    .map((d) => [d.successor_id, { id: d.successor_id, name: names.get(d.successor_id)! }])).values()];

  const finishAfter = after.tasks.length ? after.schedule.finish : null;
  const lateBefore = lateBy(finishBefore, ctx.project.target_date, ctx.holidays);
  const lateAfter = lateBy(finishAfter, ctx.project.target_date, ctx.holidays);

  const critBefore = new Set(before.tasks.filter((t) => t.critical).map((t) => t.id));
  const critAfter = new Set(after.tasks.filter((t) => t.critical).map((t) => t.id));

  const bookings = bookingChanges(before, after, ctx);
  const { added, cleared } = conflictChanges(before, after, ctx);

  const impact: PlanImpact = {
    risk: 'low',
    moved: moved.sort((a, b) => Math.abs(b.days) - Math.abs(a.days)),
    unlinked,
    finish: {
      before: finishBefore,
      after: finishAfter,
      days: finishBefore && finishAfter ? diffDays(finishBefore, finishAfter) : 0,
    },
    late_by: lateAfter,
    critical_added: [...critAfter].filter((id) => !critBefore.has(id)).map((id) => ({ id, name: names.get(id)! })),
    critical_removed: [...critBefore].filter((id) => !critAfter.has(id) && afterTasks.has(id))
      .map((id) => ({ id, name: names.get(id)! })),
    bookings,
    conflicts_added: added,
    conflicts_cleared: cleared,
  };
  impact.risk = riskOf(impact, {
    lateGrew: lateAfter > lateBefore,
    deletedCriticalWithSuccessors: [...deleted].some((id) => critBefore.has(id)) && unlinked.length > 0,
  });
  return impact;
}

function riskOf(i: PlanImpact, flags: { lateGrew: boolean; deletedCriticalWithSuccessors: boolean }): PlanRisk {
  if (i.conflicts_added.length || flags.lateGrew || flags.deletedCriticalWithSuccessors) return 'high';
  if (i.finish.days !== 0 || i.unlinked.length || i.moved.length || i.bookings.length) return 'medium';
  return 'low';
}

function emptyImpact(finish: ISODate | null): PlanImpact {
  return {
    risk: 'low', moved: [], unlinked: [], finish: { before: finish, after: finish, days: 0 }, late_by: 0,
    critical_added: [], critical_removed: [], bookings: [], conflicts_added: [], conflicts_cleared: [],
  };
}

function bookingChanges(before: PlanOutcome, after: PlanOutcome, ctx: ImpactContext): PlanImpact['bookings'] {
  const envName = (id: number) => ctx.environments.find((e) => e.id === id)?.name ?? 'Environment';
  const was = new Map(before.reconciliation.bookings.filter((b) => b.id != null).map((b) => [b.id!, b]));
  const out: PlanImpact['bookings'] = [];

  for (const b of after.reconciliation.bookings) {
    const prev = b.id != null ? was.get(b.id) : undefined;
    was.delete(b.id!);
    const now = { start: b.start_date, end: b.end_date };
    if (!prev) {
      out.push({ id: b.id, env_name: envName(b.environment_id), change: 'created', before: null, after: now });
      continue;
    }
    if (prev.start_date === b.start_date && prev.end_date === b.end_date) continue;
    const lenBefore = calendarDays(prev.start_date, prev.end_date);
    const lenAfter = calendarDays(b.start_date, b.end_date);
    out.push({
      id: b.id,
      env_name: envName(b.environment_id),
      change: lenAfter > lenBefore ? 'longer' : lenAfter < lenBefore ? 'shorter' : 'moved',
      before: { start: prev.start_date, end: prev.end_date },
      after: now,
    });
  }
  for (const prev of was.values()) {
    out.push({
      id: prev.id, env_name: envName(prev.environment_id), change: 'removed',
      before: { start: prev.start_date, end: prev.end_date }, after: null,
    });
  }
  return out;
}

/**
 * The team's bookings with this project's as an outcome would leave them. The
 * chart's drag preview and occupancy strip read this, so they show what the
 * impact check and the save would.
 */
export function bookingsFor(outcome: PlanOutcome, ctx: ImpactContext): BookingView[] {
  const mine = new Map(ctx.teamBookings.filter((b) => b.project_id === ctx.project.id).map((b) => [b.id, b]));
  const others = ctx.teamBookings.filter((b) => b.project_id !== ctx.project.id);
  let temp = -1;

  const planned: BookingView[] = outcome.reconciliation.bookings.map((d) => {
    const existing = d.id != null ? mine.get(d.id) : undefined;
    const env = ctx.environments.find((e) => e.id === d.environment_id);
    return {
      ...(existing ?? {
        id: temp--, project_id: ctx.project.id, environment_id: d.environment_id, kind: 'CUSTOM' as const,
        confidence: 'committed' as const, optional: 0, note: null, marker: null,
        project_name: ctx.project.name, team_id: env?.team_id ?? 0, priority: ctx.project.priority,
        env_name: env?.name ?? '', env_kind: env?.kind ?? 'OTHER', capacity: env?.capacity ?? 1,
        calendar_days: 0, working_days: 0, is_milestone: false,
      }),
      start_date: d.start_date,
      end_date: d.end_date,
      calendar_days: calendarDays(d.start_date, d.end_date),
      is_milestone: existing?.kind === 'RELEASE' || d.start_date === d.end_date,
    };
  });
  // Bookings of this project that the plan does not manage (none today) are kept as they are.
  const managed = new Set(outcome.reconciliation.bookings.map((d) => d.id));
  const untouched = [...mine.values()].filter((b) => !managed.has(b.id) && !outcome.reconciliation.remove.includes(b.id));

  return [...others, ...untouched, ...planned];
}

/** Every double-booking under an outcome, accepted ones stamped resolved. */
export function conflictsFor(outcome: PlanOutcome, ctx: ImpactContext): Conflict[] {
  return applyResolutions(detectConflicts(bookingsFor(outcome, ctx)), ctx.resolved);
}

/** The team's open double-bookings with this project's bookings as each outcome has them. */
function openFor(outcome: PlanOutcome, ctx: ImpactContext): Conflict[] {
  return openConflicts(conflictsFor(outcome, ctx));
}

export function conflictChanges(before: PlanOutcome, after: PlanOutcome, ctx: ImpactContext) {
  // Compare by which pairs of projects clash on which environment, not by booking ids
  // (a new booking has none) or by whole groups (two clashes merging into one three-way
  // clash is one new fact, not a clash cleared and another made).
  const pairs = (c: Conflict) => {
    const ids = c.projects.map((p) => p.id).sort((a, b) => a - b);
    const out: string[] = [];
    for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) out.push(`${c.environment_id}:${ids[i]}-${ids[j]}`);
    return out;
  };
  const view = (c: Conflict) => ({
    env_name: c.env_name, start_date: c.start_date, end_date: c.end_date, projects: c.projects.map((p) => p.name),
  });
  const b = openFor(before, ctx);
  const a = openFor(after, ctx);
  const bPairs = new Set(b.flatMap(pairs));
  const aPairs = new Set(a.flatMap(pairs));
  return {
    added: a.filter((c) => pairs(c).some((p) => !bPairs.has(p))).map(view),
    cleared: b.filter((c) => pairs(c).every((p) => !aPairs.has(p))).map(view),
  };
}
