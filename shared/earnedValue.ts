import { addDays, minDate, workingDays, type HolidaySet } from './dates.ts';
import { progressOf } from './progress.ts';
import { leavesOf } from './wbs.ts';
import type { ISODate, Task, TaskSchedule } from './types.ts';

/**
 * Earned value (reqs/pm_features.md §6): at a status date, is the plan behind,
 * and is it over? Pure, and the one place it is worked out: the Budget tab, the
 * review page and any later report read these numbers, never their own.
 *
 * Against the baseline the plan compares with:
 * - BAC: each working task's cost in that baseline (today's planned cost when
 *   the baseline kept none for it);
 * - PV: that cost spread evenly over the task's baseline working days, up to the
 *   status date;
 * - EV: that cost times the task's percent complete (shared/progress.ts);
 * - AC: what was really spent where someone typed it, else estimated from the
 *   working days worked × its people's day rates.
 *
 * Only working tasks count; summaries sum them. Tasks added after the baseline
 * have no budget in it, so they are left out and counted. The status date is an
 * input, never the clock.
 */

export type Money = number;

export type CostInput = {
  tasks: readonly Task[];
  schedule: ReadonlyMap<number, TaskSchedule>;
  /** Who is on each task, by task id. */
  people: ReadonlyMap<number, readonly number[]>;
  /** Cost per working day, by person; null or absent when nobody set one. */
  rates: ReadonlyMap<number, number | null | undefined>;
};

export type EarnedValueInput = CostInput & {
  /** The compared baseline's tasks, with the cost it kept (null before costs were kept). */
  snapshot: ReadonlyMap<number, { start: ISODate; end: ISODate; duration: number | null; cost: number | null }>;
  statusDate: ISODate;
  holidays?: HolidaySet;
  currency: string;
};

export type Figures = { bac: Money; pv: Money; ev: Money; ac: Money; spi: number | null; cpi: number | null };

export type EarnedValue = Figures & {
  status_date: ISODate;
  currency: string;
  sv: Money;
  cv: Money;
  /** Estimate at completion at the current cost efficiency (BAC / CPI); null until something is spent. */
  eac: Money | null;
  etc: Money | null;
  vac: Money | null;
  /** Working tasks whose spend is estimated from time × rates, and those with a typed actual cost. */
  estimated: number;
  typed: number;
  /** Working tasks added since the baseline: no budget in it, so left out. */
  outside: number;
  /** Working tasks budgeted at today's cost because the baseline kept none. */
  from_plan: number;
  /** The baseline's span, and planned value each week across it (bounded). */
  start: ISODate;
  finish: ISODate;
  series: { date: ISODate; pv: Money }[];
  /** Each summary task, in outline order, with its working tasks' figures summed. */
  summaries: (Figures & { id: number; name: string; code: number | null })[];
  verdict: Verdict;
};

/** Plain answers first, filled from the numbers; the indices sit under them in the UI. */
export type Verdict = {
  schedule: { word: 'behind' | 'ahead' | 'on' | 'none'; text: string };
  cost: { word: 'over' | 'under' | 'on' | 'none'; text: string };
  forecast: string | null;
};

export type Missing = { missing: 'baseline' | 'cost' };

/** Within this share of plan, the verdict says "on". */
export const ON_PLAN_BAND = 0.02;
/** At most this many weekly points: ten years, far past any plan. */
const SERIES_MAX = 520;

const dayRateOf = (people: readonly number[], rates: CostInput['rates']) => people.reduce((s, r) => s + (rates.get(r) ?? 0), 0);

/**
 * A working task's planned cost: its length in working days × its people's day
 * rates, plus its fixed cost. Null when it has neither a rated person nor a fixed cost.
 */
export function plannedCost(t: Pick<Task, 'duration'> & { fixed_cost?: number | null }, people: readonly number[], rates: CostInput['rates']): Money | null {
  const rated = people.some((r) => rates.get(r) != null);
  if (!rated && t.fixed_cost == null) return null;
  return Math.max(0, t.duration) * dayRateOf(people, rates) + (t.fixed_cost ?? 0);
}

/** Each task's planned cost: working tasks as `plannedCost`, summaries as the sum under them; null with none. */
export function costsOf(input: CostInput): Map<number, Money | null> {
  const out = new Map<number, Money | null>();
  for (const t of input.tasks) {
    if (input.schedule.get(t.id)?.summary) continue;
    out.set(t.id, plannedCost(t, input.people.get(t.id) ?? [], input.rates));
  }
  for (const t of input.tasks) {
    if (!input.schedule.get(t.id)?.summary) continue;
    const parts = leavesOf(input.tasks, t.id).map((id) => out.get(id) ?? null).filter((c): c is number => c != null);
    out.set(t.id, parts.length ? parts.reduce((s, c) => s + c, 0) : null);
  }
  return out;
}

/** The plan's cost bottom-up: every working task's planned cost. What a change to lengths or people moves. */
export function planCost(input: CostInput): Money | null {
  let total: Money | null = null;
  for (const t of input.tasks) {
    if (input.schedule.get(t.id)?.summary) continue;
    const c = plannedCost(t, input.people.get(t.id) ?? [], input.rates);
    if (c != null) total = (total ?? 0) + c;
  }
  return total;
}

/** Share of a baseline span planned to be done by `date`: even over its working days; a milestone at its end. */
export function plannedShare(span: { start: ISODate; end: ISODate; duration: number | null }, date: ISODate, holidays?: HolidaySet): number {
  if (date < span.start) return 0;
  if (date >= span.end) return 1;
  if (span.duration === 0) return 0;
  const days = workingDays(span.start, span.end, holidays);
  if (days <= 0) return 1;
  return Math.min(1, workingDays(span.start, date, holidays) / days);
}

const ratio = (a: Money, b: Money) => (b > 0 ? a / b : null);

export function earnedValue(input: EarnedValueInput): EarnedValue | Missing {
  if (!input.snapshot.size) return { missing: 'baseline' };
  const { statusDate, holidays, rates } = input;
  const working = input.tasks.filter((t) => !input.schedule.get(t.id)?.summary);

  type Row = { id: number; bac: Money; ev: Money; ac: Money; span: { start: ISODate; end: ISODate; duration: number | null } };
  const rows = new Map<number, Row>();
  let estimated = 0;
  let typed = 0;
  let outside = 0;
  let fromPlan = 0;

  for (const t of working) {
    const span = input.snapshot.get(t.id);
    if (!span) { outside++; continue; }
    const people = input.people.get(t.id) ?? [];
    const now = plannedCost(t, people, rates);
    const bac = span.cost ?? now;
    if (bac == null) continue;
    if (span.cost == null) fromPlan++;
    const progress = progressOf(t, statusDate, holidays) / 100;
    let ac: Money;
    if (t.actual_cost != null) {
      ac = t.actual_cost;
      typed++;
    } else {
      ac = spentEstimate(t, people, rates, bac, progress, statusDate, holidays);
      if (ac > 0) estimated++;
    }
    rows.set(t.id, { id: t.id, bac, ev: bac * progress, ac, span });
  }

  const sum = (ids: Iterable<number>): Figures => {
    let bac = 0, pv = 0, ev = 0, ac = 0;
    for (const id of ids) {
      const r = rows.get(id);
      if (!r) continue;
      bac += r.bac;
      pv += r.bac * plannedShare(r.span, statusDate, holidays);
      ev += r.ev;
      ac += r.ac;
    }
    return { bac, pv, ev, ac, spi: ratio(ev, pv), cpi: ratio(ev, ac) };
  };

  const all = sum(rows.keys());
  if (all.bac <= 0) return { missing: 'cost' };

  const spans = [...rows.values()].map((r) => r.span);
  const start = spans.reduce((m, s) => (s.start < m ? s.start : m), spans[0].start);
  const finish = spans.reduce((m, s) => (s.end > m ? s.end : m), spans[0].end);
  const series: EarnedValue['series'] = [];
  for (let d = start, guard = 0; guard < SERIES_MAX; d = addDays(d, 7), guard++) {
    const at = minDate(d, finish);
    series.push({ date: at, pv: [...rows.values()].reduce((s, r) => s + r.bac * plannedShare(r.span, at, holidays), 0) });
    if (at >= finish) break;
  }

  const eac = all.cpi ? all.bac / all.cpi : null;
  const summaries = input.tasks
    .filter((t) => input.schedule.get(t.id)?.summary)
    .map((t) => ({ id: t.id, name: t.name, code: t.code ?? null, ...sum(leavesOf(input.tasks, t.id)) }))
    .filter((s) => s.bac > 0);

  const out: Omit<EarnedValue, 'verdict'> = {
    status_date: statusDate,
    currency: input.currency,
    ...all,
    sv: all.ev - all.pv,
    cv: all.ev - all.ac,
    eac,
    etc: eac != null ? Math.max(0, eac - all.ac) : null,
    vac: eac != null ? all.bac - eac : null,
    estimated,
    typed,
    outside,
    from_plan: fromPlan,
    start,
    finish,
    series,
    summaries,
  };
  return { ...out, verdict: verdictOf(out) };
}

/**
 * Spent so far, when nobody typed it: the working days worked up to the status
 * date × the people's day rates, plus the fixed cost as far as the work is done.
 * With no rates, the budget pro rata to the days worked.
 */
function spentEstimate(
  t: Task, people: readonly number[], rates: CostInput['rates'], bac: Money, progress: number, statusDate: ISODate, holidays?: HolidaySet,
): Money {
  if (!t.actual_start || t.actual_start > statusDate) return 0;
  const until = t.actual_end && t.actual_end < statusDate ? t.actual_end : statusDate;
  const worked = workingDays(t.actual_start, until, holidays);
  const rated = people.some((r) => rates.get(r) != null);
  if (rated) return worked * dayRateOf(people, rates) + (t.fixed_cost ?? 0) * progress;
  if (t.fixed_cost != null) return t.fixed_cost * progress;
  return bac * Math.min(1, worked / Math.max(1, t.duration));
}

/** Money as the plan's currency shows it, whole units. */
export function formatMoney(n: Money, currency: string): string {
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency, maximumFractionDigits: 0, minimumFractionDigits: 0 }).format(Math.round(n));
  } catch {
    return `${Math.round(n).toLocaleString('en-GB')} ${currency}`;
  }
}

/** The opening sentences. Within `ON_PLAN_BAND` of plan reads as on it. */
export function verdictOf(e: Omit<EarnedValue, 'verdict'>): Verdict {
  const m = (n: Money) => formatMoney(Math.abs(n), e.currency);
  const pct = (x: number) => `${Math.max(1, Math.round(Math.abs(1 - x) * 100))}%`;

  let schedule: Verdict['schedule'];
  if (e.spi == null) schedule = { word: 'none', text: 'Nothing was planned to be done by now.' };
  else if (Math.abs(1 - e.spi) <= ON_PLAN_BAND) schedule = { word: 'on', text: 'On schedule. The work done is worth what was planned by now.' };
  else if (e.spi < 1) schedule = { word: 'behind', text: `${pct(e.spi)} behind schedule. Work worth ${m(e.pv - e.ev)} that was planned by now hasn’t been done.` };
  else schedule = { word: 'ahead', text: `${pct(e.spi)} ahead of schedule. ${m(e.ev - e.pv)} more work is done than was planned by now.` };

  let cost: Verdict['cost'];
  if (e.cpi == null) cost = { word: 'none', text: 'Nothing spent yet.' };
  else if (Math.abs(1 - e.cpi) <= ON_PLAN_BAND) cost = { word: 'on', text: 'On budget. The work done cost what was planned.' };
  else if (e.cpi < 1) cost = { word: 'over', text: `${pct(e.cpi)} over budget. The work done so far cost ${m(e.ac - e.ev)} more than planned.` };
  else cost = { word: 'under', text: `${pct(e.cpi)} under budget. The work done so far cost ${m(e.ev - e.ac)} less than planned.` };

  let forecast: string | null = null;
  if (e.eac != null && e.vac != null) {
    forecast = Math.abs(e.vac) <= e.bac * 0.005
      ? `Heading for ${m(e.eac)}, on the ${m(e.bac)} budget.`
      : `Heading for ${m(e.eac)}, ${m(e.vac)} ${e.vac < 0 ? 'over' : 'under'} the ${m(e.bac)} budget at this rate.`;
  }
  return { schedule, cost, forecast };
}
