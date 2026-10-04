import { addDays, workingDays, type HolidaySet } from '../dates.ts';
import type { PlanOutcome } from '../plan.ts';
import { earliestStart, expandLinks, forwardPass, indexNetwork, lateBy, scheduleProject } from '../schedule.ts';
import type { Conflict, ISODate, Priority, TaskDependency, TaskStatus } from '../types.ts';
import { forecast, type Forecast } from './forecast.ts';
import { planOverlaps, workItems, type PersonOverlap, type WorkItem } from '../workload.ts';

/**
 * Everything the assistant's rules read, derived once from a plan outcome
 * (reqs/smart_assistant.md §5.2). Rules never touch raw rows, and the LLM digest
 * (Phase 5) is built from these same facts, so both approaches agree.
 *
 * Pure. The status date is an input, never the clock, so a test pins it.
 */

export type TaskFacts = {
  id: number;
  code: number | null;
  name: string;
  summary: boolean;
  status: TaskStatus;
  /** Working days of effort as planned. */
  duration: number;
  /** Working days of effort still to do on the status date. */
  remaining: number;
  /** Percent complete as typed; null when nobody typed one. */
  progress: number | null;
  start: ISODate;
  end: ISODate;
  total_float: number;
  free_float: number;
  critical: boolean;
  /** Not critical, but within the near-critical threshold of it. */
  near_critical: boolean;
  /** Working tasks this one waits on / that wait on it, summaries expanded. */
  preds: number[];
  succs: number[];
  /**
   * Earned-schedule pace for work in progress with a typed figure: work earned
   * per working day elapsed. 1 is on plan; null when it cannot be measured.
   */
  spi: number | null;
  /** Working days it will run past its scheduled end at that pace; 0 when on pace. */
  slip: number;
  /** Its start is held by a "start no earlier than" (its own or a summary's), not by its links. */
  driven_by_constraint: boolean;
  not_before: ISODate | null;
  /** The deadline that counts (its own or a summary's) and working days to spare; null with none. */
  deadline: ISODate | null;
  deadline_slack: number | null;
  /** Its negative float comes from a deadline (its own or one after it), not from a fixed date. */
  deadline_driven: boolean;
  baseline_end: ISODate | null;
  environment_id: number | null;
  people: number[];
  /** Best and worst case as typed; null when the forecast uses its default. */
  best: number | null;
  worst: number | null;
};

export type ClashFacts = {
  conflict: Conflict;
  /** This project's unfinished working tasks on that environment inside the clash. */
  task_ids: number[];
  /** Other projects in the clash. */
  others: { id: number; name: string; priority: Priority }[];
};

export type PlanFacts = {
  project: { id: number; name: string; priority: Priority; target_date: ISODate | null };
  status_date: ISODate;
  start: ISODate | null;
  finish: ISODate | null;
  /** Working days past target; 0 when on time or no target. */
  late_by: number;
  /** Working days from finish to target: negative when late, null with no target. */
  target_slack: number | null;
  /** Working days of the plan still ahead of the status date. */
  remaining_length: number;
  critical_path: number[];
  tasks: TaskFacts[];
  byId: Map<number, TaskFacts>;
  /** Links between working tasks, summaries expanded. */
  links: TaskDependency[];
  /** The links as typed, for the lead and lag checks. */
  raw_links: readonly TaskDependency[];
  baseline: {
    finish: ISODate;
    /** Working tasks the baseline says should be finished before the status date. */
    due: number[];
    /** Of those, the ones that are done. */
    done: number[];
  } | null;
  /** Open double-bookings this project is part of. */
  clashes: ClashFacts[];
  near_critical_days: number;
  /** The Monte Carlo forecast (forecast.ts), when one was run. */
  forecast: Forecast | null;
  holidays?: HolidaySet;
  /**
   * A person on two tasks at once, where at least one is this plan's
   * (shared/workload.ts, counting their work in other plans). Working days.
   */
  overlaps: OverlapFacts[];
  /** Working days of all those overlaps together: what levelling brings down. */
  overlap_days: number;
};

/** One overlap, with both tasks' spans and, for another plan's task, where it lives. */
export type OverlapFacts = PersonOverlap & {
  spans: Record<number, { start: ISODate; end: ISODate; here: boolean; name: string; code: number | null; project_name: string | null }>;
};

/** Another plan's task one of this plan's people is on (server/queries.ts `workElsewhere`). */
export type ElsewhereWork = WorkItem & { name: string; code: number | null; project_name: string };

export type FactsInput = {
  project: { id: number; name: string; priority: Priority; target_date?: ISODate | null };
  projectStart: ISODate;
  outcome: PlanOutcome;
  /** Saved baseline dates by task id; empty when there is none. */
  baseline: ReadonlyMap<number, { start: ISODate; end: ISODate }>;
  /** Who is on each task, by task id. */
  people: ReadonlyMap<number, readonly number[]>;
  /** The team's double-bookings with accepted ones stamped resolved (`conflictsFor`, or the board's). */
  conflicts: readonly Conflict[];
  statusDate: ISODate;
  nearCriticalDays: number;
  holidays?: HolidaySet;
  /** Forecast runs; 0 or absent skips the forecast. */
  forecastRuns?: number;
  /** This plan's people's open work in other plans, so an overlap with it counts. */
  elsewhere?: readonly ElsewhereWork[];
};

/**
 * Tasks whose negative float is a deadline's doing: negative with deadlines, not
 * without them. One more schedule, and only when a deadline has made float negative.
 */
function negativeFromDeadlines(input: FactsInput): Set<number> {
  const { outcome } = input;
  const negative = [...outcome.schedule.tasks.values()].filter((s) => s.total_float < 0);
  if (!negative.length || !outcome.tasks.some((t) => t.deadline)) return new Set();
  const without = scheduleProject({
    tasks: outcome.tasks.map((t) => ({ ...t, deadline: null })), deps: outcome.deps,
    projectStart: input.projectStart, holidays: input.holidays, external: outcome.external,
  });
  if ('cycle' in without) return new Set();
  return new Set(negative.filter((s) => (without.tasks.get(s.id)?.total_float ?? 0) >= 0).map((s) => s.id));
}

/** Working days strictly after `from`, up to and including `to`; 0 when `to` is not later. */
export function workingDaysAfter(from: ISODate, to: ISODate, holidays?: HolidaySet): number {
  return to > from ? workingDays(addDays(from, 1), to, holidays) : 0;
}

export function planFacts(input: FactsInput): PlanFacts {
  const { outcome, statusDate, holidays } = input;
  const sched = outcome.schedule.tasks;
  const outlineTasks = outcome.tasks.map((t) => ({ ...t, sort_order: t.sort_order ?? 0 }));
  const summaries = new Set(outcome.tasks.filter((t) => sched.get(t.id)?.summary).map((t) => t.id));
  const links = expandLinks(outlineTasks, outcome.deps, summaries);

  const preds = new Map<number, Set<number>>();
  const succs = new Map<number, Set<number>>();
  for (const d of links) {
    (preds.get(d.successor_id) ?? preds.set(d.successor_id, new Set()).get(d.successor_id)!).add(d.predecessor_id);
    (succs.get(d.predecessor_id) ?? succs.set(d.predecessor_id, new Set()).get(d.predecessor_id)!).add(d.successor_id);
  }

  const driven = constraintDriven(input);
  const deadlineDriven = negativeFromDeadlines(input);

  const tasks: TaskFacts[] = outcome.tasks.map((t) => {
    const s = sched.get(t.id)!;
    const summary = !!s.summary;
    const duration = Math.max(0, t.duration);
    const pace = summary ? { spi: null, slip: 0 } : paceOf(t, duration, statusDate, holidays);
    const critical = s.critical;
    return {
      id: t.id,
      code: t.code ?? null,
      name: t.name,
      summary,
      status: t.status,
      duration,
      remaining: remainingOf(t, duration, s.end, statusDate, holidays),
      progress: t.progress ?? null,
      start: s.start,
      end: s.end,
      total_float: s.total_float,
      free_float: s.free_float,
      critical,
      near_critical: !critical && t.status !== 'done' && s.total_float > 0 && s.total_float <= input.nearCriticalDays,
      preds: [...(preds.get(t.id) ?? [])].sort((a, b) => a - b),
      succs: [...(succs.get(t.id) ?? [])].sort((a, b) => a - b),
      spi: pace.spi,
      slip: pace.slip,
      driven_by_constraint: driven.has(t.id),
      not_before: t.not_before,
      deadline: s.deadline ?? null,
      deadline_slack: s.deadline_slack ?? null,
      deadline_driven: deadlineDriven.has(t.id),
      baseline_end: input.baseline.get(t.id)?.end ?? null,
      environment_id: summary ? null : t.environment_id,
      people: [...(input.people.get(t.id) ?? [])],
      best: summary ? null : t.duration_low ?? null,
      worst: summary ? null : t.duration_high ?? null,
    };
  });
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const working = tasks.filter((t) => !t.summary);

  const finish = working.length ? outcome.schedule.finish : null;
  const target = input.project.target_date ?? null;
  const late = lateBy(finish, target, holidays);
  const targetSlack = !finish || !target ? null
    : late > 0 ? -late
    : workingDaysAfter(finish, target, holidays);
  const aheadFrom = outcome.schedule.start > statusDate ? outcome.schedule.start : statusDate;

  return {
    project: { ...input.project, target_date: target },
    status_date: statusDate,
    start: working.length ? outcome.schedule.start : null,
    finish,
    late_by: late,
    target_slack: targetSlack,
    remaining_length: finish && finish >= aheadFrom ? workingDays(aheadFrom, finish, holidays) : 0,
    critical_path: outcome.schedule.critical_path,
    tasks,
    byId,
    links,
    raw_links: outcome.deps,
    baseline: baselineFacts(working, statusDate),
    clashes: clashFacts(input, working),
    near_critical_days: input.nearCriticalDays,
    forecast: input.forecastRuns ? forecast({
      tasks: outcome.tasks,
      deps: outcome.deps,
      projectStart: input.projectStart,
      statusDate,
      target,
      runs: input.forecastRuns,
      holidays,
      pace: new Map(working.map((t) => [t.id, t.spi])),
      external: outcome.external,
    }, new Set(working.filter((t) => t.critical && t.status !== 'done').map((t) => t.id))) : null,
    holidays,
    ...overlapFacts(input, outcome, tasks),
  };
}

/** People on two tasks at once (shared/workload.ts's rule), with the spans a levelling move needs. */
function overlapFacts(input: FactsInput, outcome: PlanOutcome, tasks: readonly TaskFacts[]): Pick<PlanFacts, 'overlaps' | 'overlap_days'> {
  const here = workItems(outcome.tasks, outcome.schedule.tasks, (id) => input.people.get(id));
  const elsewhere = input.elsewhere ?? [];
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const other = new Map(elsewhere.map((w) => [w.task_id, w]));
  const span = (id: number): OverlapFacts['spans'][number] => {
    const t = byId.get(id);
    if (t) return { start: t.start, end: t.end, here: true, name: t.name, code: t.code, project_name: null };
    const w = other.get(id);
    return { start: w?.start ?? '', end: w?.end ?? '', here: false, name: w?.name ?? `task ${id}`, code: w?.code ?? null, project_name: w?.project_name ?? null };
  };
  const overlaps = [...planOverlaps(here, elsewhere, input.holidays).values()].flat()
    .map((o) => ({ ...o, spans: { [o.a]: span(o.a), [o.b]: span(o.b) } }));
  return { overlaps, overlap_days: overlaps.reduce((s, o) => s + o.days, 0) };
}

/** Effort left: none when done; the untyped share when progress is typed; otherwise what the schedule has left. */
function remainingOf(
  t: { status: TaskStatus; progress?: number | null }, duration: number, end: ISODate, statusDate: ISODate, holidays?: HolidaySet,
): number {
  if (t.status === 'done') return 0;
  if (t.status !== 'in_progress') return duration;
  if (t.progress != null) return Math.ceil(duration * (1 - Math.min(100, Math.max(0, t.progress)) / 100));
  return end >= statusDate ? Math.min(duration, workingDays(statusDate, end, holidays)) : 0;
}

/**
 * Earned schedule for one task: the working days of work its typed progress has
 * earned, over the working days it has been running (up to the day before the
 * status date). Two days at least, so a task started yesterday is not judged.
 */
function paceOf(
  t: { status: TaskStatus; progress?: number | null; actual_start: ISODate | null },
  duration: number, statusDate: ISODate, holidays?: HolidaySet,
): { spi: number | null; slip: number } {
  if (t.status !== 'in_progress' || t.progress == null || !t.actual_start || duration <= 0) return { spi: null, slip: 0 };
  const elapsed = workingDaysAfter(addDays(t.actual_start, -1), addDays(statusDate, -1), holidays);
  if (elapsed < 2) return { spi: null, slip: 0 };
  const earned = (Math.min(100, Math.max(0, t.progress)) / 100) * duration;
  const spi = earned / elapsed;
  if (spi >= 1) return { spi, slip: 0 };
  // At zero pace nothing projects a finish; it is at least as late as the time already spent.
  const slip = spi > 0 ? Math.ceil(duration / spi) - duration : elapsed;
  return { spi, slip };
}

/** Tasks whose start their floor holds later than their links would (DCMA #5, a driving constraint). */
function constraintDriven(input: FactsInput): Set<number> {
  const net = indexNetwork({
    tasks: input.outcome.tasks, deps: input.outcome.deps, projectStart: input.projectStart, holidays: input.holidays,
  });
  const out = new Set<number>();
  if ('cycle' in net) return out;
  const f = forwardPass(net);
  net.ids.forEach((id, i) => {
    const st = net.state[i];
    if (st.kind !== 'free' || st.floor == null) return;
    const duration = net.durations[i];
    let fromLinks = 0;
    for (const p of net.preds[i]) fromLinks = Math.max(fromLinks, earliestStart(p.type, f.es[p.from], f.ef[p.from], p.lag, duration));
    if (f.es[i] > fromLinks) out.add(id);
  });
  return out;
}

function baselineFacts(working: readonly TaskFacts[], statusDate: ISODate): PlanFacts['baseline'] {
  const saved = working.filter((t) => t.baseline_end);
  if (!saved.length) return null;
  const due = saved.filter((t) => t.baseline_end! < statusDate);
  return {
    finish: saved.reduce((m, t) => (t.baseline_end! > m ? t.baseline_end! : m), saved[0].baseline_end!),
    due: due.map((t) => t.id),
    done: due.filter((t) => t.status === 'done').map((t) => t.id),
  };
}

function clashFacts(input: FactsInput, working: readonly TaskFacts[]): ClashFacts[] {
  const out: ClashFacts[] = [];
  for (const c of input.conflicts) {
    if (c.resolved || !c.projects.some((p) => p.id === input.project.id)) continue;
    const task_ids = working
      .filter((t) => t.status !== 'done' && t.environment_id === c.environment_id && t.start <= c.end_date && t.end >= c.start_date)
      .map((t) => t.id);
    out.push({ conflict: c, task_ids, others: c.projects.filter((p) => p.id !== input.project.id) });
  }
  return out;
}
