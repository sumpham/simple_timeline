import { workingShift } from '../variance.ts';
import { formatMoney, plannedCost } from '../earnedValue.ts';
import { bookingsFor, conflictsFor, planImpact } from '../plan.ts';
import { openConflicts } from '../conflicts.ts';
import { inOutlineOrder } from '../wbs.ts';
import { planOverlaps, workItems, type PersonOverlap, type WorkItem } from '../workload.ts';
import { createSearch, type Evaluation, type PlanState, type SearchContext } from './optimise.ts';
import { day, label } from './rules.ts';
import type { PlanOp } from './moves.ts';
import type { BookingView, Conflict, DownstreamEffect, ISODate, PlanImpact, TaskDependency } from '../types.ts';

/**
 * Review a suggestion before applying it (reqs/pm_features.md §8): the plan as
 * it is and as the ops would leave it, side by side, with what changed between
 * them in words.
 *
 * Both plans come from the better-plan search's own functions (`createSearch`,
 * `tryOps`, `withForecast`), which run `ctx.apply`, the save's `applyChange`.
 * So the to-be plan here is the plan Apply writes; nothing in this file works
 * out a span, a float or a clash itself. `diffPlans` is the one place two plans
 * are compared, and the review page only draws what it returns.
 */

/** A task as the review page draws it. */
export type ReviewTask = {
  id: number;
  name: string;
  code: number | null;
  parent_id: number | null;
  summary: boolean;
  milestone: boolean;
  environment_id: number | null;
  not_before: ISODate | null;
  duration: number;
  start: ISODate;
  end: ISODate;
  total_float: number;
  critical: boolean;
  resource_ids: number[];
  /** The deadline that counts and working days to spare (negative when late); null with none. */
  deadline: ISODate | null;
  deadline_slack: number | null;
  /** Its planned cost (shared/earnedValue.ts); null with no rate or fixed cost. Working tasks only. */
  cost: number | null;
};

/** One side of a review: the plan as it is, or as the suggestion would leave it. */
export type ReviewSide = {
  /** In outline order. */
  tasks: ReviewTask[];
  deps: TaskDependency[];
  finish: ISODate | null;
  /** Working days past the target; 0 with no target. */
  late: number;
  forecast: { p80: ISODate; on_time: number | null } | null;
  /** The team's bookings on the environments the review touches. */
  bookings: BookingView[];
  /** Every double-booking on those environments, accepted ones stamped resolved. */
  conflicts: Conflict[];
  /** People's work that overlaps on either side, here and in other plans, for the People view. */
  work: WorkItem[];
  overlaps: PersonOverlap[];
};

export type TaskChange = {
  id: number;
  label: string;
  kind: 'changed' | 'created' | 'removed';
  /** Working days the start and finish move; positive is later. */
  start: number;
  finish: number;
  duration: { before: number; after: number } | null;
  environment: { before: number | null; after: number | null } | null;
  float: { before: number; after: number } | null;
  critical: 'gained' | 'lost' | null;
  not_before: { before: ISODate | null; after: ISODate | null } | null;
  links: boolean;
  /** Past its deadline after the change but not before, or the other way round. */
  deadline: { change: 'missed' | 'met'; date: ISODate; days: number } | null;
};

export type OverlapView = PersonOverlap & { name: string; a_label: string; b_label: string };

export type ReviewDiff = {
  /** Working tasks only: a summary is a roll-up and moves with them. */
  tasks: TaskChange[];
  unchanged: number;
  bookings: PlanImpact['bookings'];
  clashes_opened: PlanImpact['conflicts_added'];
  clashes_cleared: PlanImpact['conflicts_cleared'];
  overlaps_opened: OverlapView[];
  overlaps_cleared: OverlapView[];
  finish: { before: ISODate | null; after: ISODate | null; days: number };
  late: { before: number; after: number };
  p80: { before: ISODate; after: ISODate; days: number } | null;
  on_time: { before: number; after: number } | null;
  /** Environments whose bookings or double-bookings differ, for the Environments view. */
  environment_ids: number[];
  /** People whose overlaps differ, or who are on a task that moves, for the People view. */
  resource_ids: number[];
  /** Plans linked after this one that the change moves (server-side; shared/projectLinks.ts). */
  downstream?: DownstreamEffect[];
  /** What the plan costs bottom-up, before and after, and the tasks whose cost changes; null when nothing is costed. */
  cost: { before: number; after: number; currency: string; tasks: { id: number; label: string; before: number | null; after: number | null }[] } | null;
};

/** What the review says first: worse things before better ones, never hidden. */
export type Verdict = { worse: string[]; better: string[]; same: string };

export type PlanReview = {
  version: string;
  status_date: ISODate;
  before: ReviewSide;
  after: ReviewSide;
  diff: ReviewDiff;
  verdict: Verdict;
  impact: PlanImpact;
};

export { workingShift };

/**
 * The plan before and after `ops`, the difference, and the verdict. Refused,
 * with the reason, when a save would refuse an op or the ops make a loop.
 */
export function buildReview(
  ctx: SearchContext,
  state: PlanState,
  ops: readonly PlanOp[],
  o: {
    version: string; elsewhere: readonly WorkItem[]; names: ReadonlyMap<number, string>;
    /** Day rates by person, and the plan's currency, for the Budget view; absent leaves cost out. */
    rates?: ReadonlyMap<number, number | null>; currency?: string;
  },
): PlanReview | { refused: string } {
  const search = createSearch(ctx, state);
  if (!search) return { refused: 'This plan has a dependency loop. Remove one of its links.' };
  // Apply once outside the search so a refused op says why, as a save would.
  try {
    let s = state;
    for (const op of ops) s = ctx.apply(s, op);
  } catch (err) {
    return { refused: err instanceof Error ? err.message : 'A save would refuse one of these changes.' };
  }
  const after = search.tryOps(state, ops);
  if (!after) return { refused: 'These changes would make a dependency loop.' };
  const before = search.withForecast(search.root);
  search.withForecast(after);

  const impact = planImpact(before.outcome, after.outcome, ctx.impact);
  const rates = o.rates ?? new Map();
  const raw = { before: rawSide(before, ctx, o.elsewhere, rates), after: rawSide(after, ctx, o.elsewhere, rates) };
  const diff = diffPlans(raw.before, raw.after, impact, { ctx, names: o.names, currency: o.currency ?? 'EUR' });
  const keep = (s: RawSide): ReviewSide => ({
    tasks: s.tasks,
    deps: s.deps,
    finish: s.finish,
    late: s.late,
    forecast: s.forecast,
    bookings: s.bookings.filter((b) => diff.environment_ids.includes(b.environment_id)),
    conflicts: s.conflicts.filter((c) => diff.environment_ids.includes(c.environment_id)),
    work: s.work.filter((w) => w.resource_ids.some((r) => diff.resource_ids.includes(r))),
    overlaps: s.overlaps,
  });
  return {
    version: o.version,
    status_date: ctx.statusDate,
    before: keep(raw.before),
    after: keep(raw.after),
    diff,
    verdict: verdictOf(diff, ctx),
    impact,
  };
}

type RawSide = ReviewSide & { open: Conflict[] };

function rawSide(e: Evaluation, ctx: SearchContext, elsewhere: readonly WorkItem[], rates: ReadonlyMap<number, number | null>): RawSide {
  const sched = e.outcome.schedule.tasks;
  const byId = new Map(e.state.tasks.map((t) => [t.id, t]));
  const tasks = inOutlineOrder(e.outcome.tasks).map((t): ReviewTask => {
    const s = sched.get(t.id)!;
    return {
      id: t.id, name: t.name, code: t.code ?? null, parent_id: t.parent_id ?? null,
      summary: !!s.summary, milestone: !s.summary && t.duration === 0,
      environment_id: s.summary ? null : t.environment_id, not_before: byId.get(t.id)?.not_before ?? null,
      duration: t.duration, start: s.start, end: s.end, total_float: s.total_float, critical: s.critical,
      resource_ids: [...(ctx.people.get(t.id) ?? [])],
      deadline: s.deadline ?? null,
      deadline_slack: s.deadline_slack ?? null,
      cost: s.summary ? null : plannedCost(t, ctx.people.get(t.id) ?? [], rates),
    };
  });
  const here = workItems(e.outcome.tasks, sched, (id) => ctx.people.get(id));
  const overlaps = [...planOverlaps(here, elsewhere, ctx.holidays).values()].flat();
  const conflicts = conflictsFor(e.outcome, ctx.impact);
  return {
    tasks,
    deps: [...e.outcome.deps],
    finish: e.finish,
    late: e.late,
    forecast: e.forecast ? { p80: e.forecast.p80, on_time: e.forecast.on_time } : null,
    bookings: bookingsFor(e.outcome, ctx.impact),
    conflicts,
    open: openConflicts(conflicts),
    work: [...here, ...elsewhere],
    overlaps,
  };
}

/** Everything that differs between two sides of a review, in the plan's own numbers. */
export function diffPlans(
  before: RawSide,
  after: RawSide,
  impact: PlanImpact,
  o: { ctx: Pick<SearchContext, 'holidays' | 'project'>; names: ReadonlyMap<number, string>; currency?: string },
): ReviewDiff {
  const h = o.ctx.holidays;
  const was = new Map(before.tasks.map((t) => [t.id, t]));
  const now = new Map(after.tasks.map((t) => [t.id, t]));
  const preds = (deps: readonly TaskDependency[], id: number) => deps.filter((d) => d.successor_id === id)
    .map((d) => `${d.predecessor_id}:${d.type ?? 'FS'}:${d.lag}`).sort().join(',');

  const tasks: TaskChange[] = [];
  let unchanged = 0;
  for (const t of after.tasks) {
    if (t.summary) continue;
    const b = was.get(t.id);
    if (!b) {
      tasks.push({
        id: t.id, label: label(t), kind: 'created', start: 0, finish: 0, duration: null, environment: null,
        float: null, critical: t.critical ? 'gained' : null, not_before: null, links: false,
        deadline: t.deadline && t.deadline_slack! < 0 ? { change: 'missed', date: t.deadline, days: -t.deadline_slack! } : null,
      });
      continue;
    }
    const c: TaskChange = {
      id: t.id, label: label(t), kind: 'changed',
      start: workingShift(b.start, t.start, h),
      finish: workingShift(b.end, t.end, h),
      duration: b.duration !== t.duration ? { before: b.duration, after: t.duration } : null,
      environment: b.environment_id !== t.environment_id ? { before: b.environment_id, after: t.environment_id } : null,
      float: b.total_float !== t.total_float ? { before: b.total_float, after: t.total_float } : null,
      critical: b.critical === t.critical ? null : t.critical ? 'gained' : 'lost',
      not_before: b.not_before !== t.not_before ? { before: b.not_before, after: t.not_before } : null,
      links: preds(before.deps, t.id) !== preds(after.deps, t.id),
      deadline: deadlineChange(b, t),
    };
    const moved = c.start || c.finish || c.duration || c.environment || c.float || c.critical || c.not_before || c.links || c.deadline;
    if (moved) tasks.push(c); else unchanged++;
  }
  for (const b of before.tasks) {
    if (b.summary || now.has(b.id)) continue;
    tasks.push({
      id: b.id, label: label(b), kind: 'removed', start: 0, finish: 0, duration: null, environment: null,
      float: null, critical: null, not_before: null, links: false, deadline: null,
    });
  }

  // People: a pair is the same overlap whatever its dates, so a moved overlap is not "cleared and opened".
  const labelOf = (id: number) => {
    const t = now.get(id) ?? was.get(id);
    return t ? label(t) : `another plan’s task ${id}`;
  };
  const view = (x: PersonOverlap): OverlapView => ({
    ...x, name: o.names.get(x.resource_id) ?? 'Someone', a_label: labelOf(x.a), b_label: labelOf(x.b),
  });
  const pairKey = (x: PersonOverlap) => `${x.resource_id}:${Math.min(x.a, x.b)}:${Math.max(x.a, x.b)}`;
  const beforePairs = new Set(before.overlaps.map(pairKey));
  const afterPairs = new Set(after.overlaps.map(pairKey));
  const overlaps_opened = after.overlaps.filter((x) => !beforePairs.has(pairKey(x))).map(view);
  const overlaps_cleared = before.overlaps.filter((x) => !afterPairs.has(pairKey(x))).map(view);

  // Environments: any booking of this plan that moved, and any double-booking that came or went.
  const envs = new Set<number>();
  const mine = (s: RawSide) => new Map(s.bookings.filter((b) => b.project_id === o.ctx.project.id).map((b) => [b.id, b]));
  const bMine = mine(before);
  const aMine = mine(after);
  for (const [id, b] of aMine) {
    const p = bMine.get(id);
    if (!p || p.start_date !== b.start_date || p.end_date !== b.end_date || p.environment_id !== b.environment_id) {
      envs.add(b.environment_id);
      if (p) envs.add(p.environment_id);
    }
  }
  for (const [id, p] of bMine) if (!aMine.has(id)) envs.add(p.environment_id);
  const clashKey = (c: Conflict) => `${c.environment_id}:${c.start_date}:${c.end_date}:${c.booking_ids.join('-')}`;
  const bOpen = new Set(before.open.map(clashKey));
  const aOpen = new Set(after.open.map(clashKey));
  for (const c of after.open) if (!bOpen.has(clashKey(c))) envs.add(c.environment_id);
  for (const c of before.open) if (!aOpen.has(clashKey(c))) envs.add(c.environment_id);

  const changedIds = new Set(tasks.filter((t) => t.start || t.finish || t.kind !== 'changed').map((t) => t.id));
  const people = new Set<number>();
  for (const x of [...overlaps_opened, ...overlaps_cleared]) people.add(x.resource_id);
  for (const t of [...after.tasks, ...before.tasks]) if (changedIds.has(t.id)) for (const r of t.resource_ids) people.add(r);

  // Cost bottom-up: only when something on either side is costed.
  const total = (s: RawSide) => s.tasks.reduce((sum, t) => sum + (t.cost ?? 0), 0);
  const costed = [...before.tasks, ...after.tasks].some((t) => t.cost != null);
  const costTasks = costed ? [...new Set([...before.tasks, ...after.tasks].map((t) => t.id))].flatMap((id) => {
    const b = was.get(id)?.cost ?? null;
    const a = now.get(id)?.cost ?? null;
    const t = now.get(id) ?? was.get(id)!;
    return b !== a && !t.summary ? [{ id, label: label(t), before: b, after: a }] : [];
  }) : [];

  const fb = before.forecast;
  const fa = after.forecast;
  return {
    cost: costed ? { before: total(before), after: total(after), currency: o.currency ?? 'EUR', tasks: costTasks } : null,
    tasks,
    unchanged,
    bookings: impact.bookings,
    clashes_opened: impact.conflicts_added,
    clashes_cleared: impact.conflicts_cleared,
    overlaps_opened,
    overlaps_cleared,
    finish: {
      before: before.finish, after: after.finish,
      days: before.finish && after.finish ? workingShift(before.finish, after.finish, h) : 0,
    },
    late: { before: before.late, after: after.late },
    p80: fb && fa ? { before: fb.p80, after: fa.p80, days: workingShift(fb.p80, fa.p80, h) } : null,
    on_time: fb?.on_time != null && fa?.on_time != null ? { before: fb.on_time, after: fa.on_time } : null,
    environment_ids: [...envs].sort((a, b) => a - b),
    resource_ids: [...people].sort((a, b) => a - b),
  };
}

/** A deadline newly missed or newly met; null when it is on the same side of it as before. */
function deadlineChange(b: ReviewTask, t: ReviewTask): TaskChange['deadline'] {
  const late = (x: ReviewTask) => x.deadline_slack != null && x.deadline_slack < 0;
  if (late(t) && !late(b)) return { change: 'missed', date: t.deadline!, days: -t.deadline_slack! };
  if (late(b) && !late(t)) return { change: 'met', date: b.deadline!, days: -b.deadline_slack! };
  return null;
}

const wd = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

function list(xs: readonly string[], max = 3): string {
  const shown = xs.slice(0, max);
  const rest = xs.length - shown.length;
  const head = shown.length === 2 && !rest ? shown.join(' and ') : shown.join(', ');
  return rest > 0 ? `${head} and ${rest} more` : head;
}

/** The review's opening sentences, filled from the diff. Anything worse comes first. */
export function verdictOf(d: ReviewDiff, ctx: Pick<SearchContext, 'project'>): Verdict {
  const worse: string[] = [];
  const better: string[] = [];
  const others = (ps: readonly string[]) => ps.filter((p) => p !== ctx.project.name);

  for (const c of d.clashes_opened) {
    const with_ = others(c.projects);
    worse.push(`Double-books ${c.env_name} ${day(c.start_date)} – ${day(c.end_date)}${with_.length ? ` with ${list(with_)}` : ''}.`);
  }
  if (d.finish.after && d.finish.days > 0) worse.push(`Finishes ${day(d.finish.after)}, ${wd(d.finish.days)} later.`);
  else if (d.p80 && d.p80.days > 0) worse.push(`The likely finish (P80) moves to ${day(d.p80.after)}, ${wd(d.p80.days)} later.`);
  if (d.late.after > d.late.before) worse.push(`Runs ${wd(d.late.after)} past the target.`);
  for (const t of d.tasks) {
    if (t.deadline?.change === 'missed') worse.push(`${t.label} misses its deadline of ${day(t.deadline.date)} by ${wd(t.deadline.days)}.`);
  }
  for (const x of d.overlaps_opened) worse.push(`${x.name} is on ${x.a_label} and ${x.b_label} at once for ${wd(x.days)}.`);
  const gained = d.tasks.filter((t) => t.critical === 'gained').map((t) => t.label);
  if (gained.length) worse.push(`${list(gained)} ${gained.length === 1 ? 'becomes' : 'become'} critical.`);
  if (d.cost && d.cost.after > d.cost.before) {
    worse.push(`Costs ${formatMoney(d.cost.after - d.cost.before, d.cost.currency)} more to deliver: ${formatMoney(d.cost.before, d.cost.currency)} → ${formatMoney(d.cost.after, d.cost.currency)}.`);
  }
  if (d.on_time && d.on_time.after < d.on_time.before) worse.push(`On-time chance ${pct(d.on_time.before)} → ${pct(d.on_time.after)}.`);

  if (d.finish.after && d.finish.days < 0) better.push(`Finishes ${day(d.finish.after)}, ${wd(-d.finish.days)} sooner.`);
  else if (d.p80 && d.p80.days < 0) better.push(`The likely finish (P80) moves to ${day(d.p80.after)}, ${wd(-d.p80.days)} sooner.`);
  if (d.on_time && d.on_time.after > d.on_time.before) better.push(`On-time chance ${pct(d.on_time.before)} → ${pct(d.on_time.after)}.`);
  for (const c of d.clashes_cleared) {
    const with_ = others(c.projects);
    better.push(`Clears the ${c.env_name} double-booking${with_.length ? ` with ${list(with_)}` : ''}, ${day(c.start_date)} – ${day(c.end_date)}.`);
  }
  for (const t of d.tasks) {
    if (t.deadline?.change === 'met') better.push(`${t.label} now meets its deadline of ${day(t.deadline.date)}.`);
  }
  for (const x of d.overlaps_cleared) better.push(`${x.name} is no longer on ${x.a_label} and ${x.b_label} at once.`);
  if (d.cost && d.cost.after < d.cost.before) {
    better.push(`Costs ${formatMoney(d.cost.before - d.cost.after, d.cost.currency)} less to deliver: ${formatMoney(d.cost.before, d.cost.currency)} → ${formatMoney(d.cost.after, d.cost.currency)}.`);
  }
  const lost = d.tasks.filter((t) => t.critical === 'lost').map((t) => t.label);
  if (lost.length) better.push(`${list(lost)} ${lost.length === 1 ? 'is' : 'are'} no longer critical.`);

  const n = d.tasks.length;
  const same = [
    `${n} task${n === 1 ? '' : 's'} change${n === 1 ? 's' : ''}; ${d.unchanged} stay${d.unchanged === 1 ? 's' : ''} as ${d.unchanged === 1 ? 'it is' : 'they are'}.`,
    d.finish.after && d.finish.days === 0 ? `The finish stays ${day(d.finish.after)}.` : '',
  ].filter(Boolean).join(' ');
  return { worse, better, same };
}
