import { diffDays, type HolidaySet } from '../dates.ts';
import { bookingsFor, conflictChanges, conflictsFor, planProject, type ImpactContext, type PlanOutcome } from '../plan.ts';
import { lateBy } from '../schedule.ts';
import type { ReconcileBooking } from '../taskHolds.ts';
import type { Environment, ISODate, Priority, Task, TaskDependency } from '../types.ts';
import { planFacts, type PlanFacts } from './facts.ts';
import { forecast, type Forecast } from './forecast.ts';
import { DISRUPTION, GENERATORS, redundantLinks, type Move, type MoveKind, type PlanOp } from './moves.ts';
import { seedOf } from './random.ts';
import { day, label } from './rules.ts';

/**
 * The better-plan search (reqs/smart_assistant.md §5.4): a bounded beam over the
 * moves in moves.ts, scored lexicographically so no move can trade the board's
 * core promise for a better number:
 *
 *   1. no new open double-booking (a hard rule, as in riskOf);
 *   2. fewer open double-bookings for this project;
 *   3. fewer days late at P80 (the forecast, finalists only) or on the plan;
 *   4. an earlier finish;
 *   5. less disruption.
 *
 * Every candidate is applied by `apply`, which the server gives as its real
 * applyChange, then scheduled by planProject and checked by conflictsFor: the
 * same functions a save runs. Pure otherwise, seeded, and bounded.
 */

export type PlanState = { tasks: readonly Task[]; deps: readonly TaskDependency[] };

export type SearchContext = {
  project: { id: number; name: string; priority: Priority; target_date: ISODate | null };
  projectStart: ISODate;
  statusDate: ISODate;
  holidays?: HolidaySet;
  /** This project's bookings that the plan manages, as planProject reconciles them. */
  bookings: readonly ReconcileBooking[];
  /** The team's bookings, environments and accepted clashes, for conflictsFor. */
  impact: ImpactContext;
  environments: readonly Environment[];
  people: ReadonlyMap<number, readonly number[]>;
  baseline: ReadonlyMap<number, { start: ISODate; end: ISODate }>;
  nearCriticalDays: number;
  longTaskDays: number;
  /** Runs per finalist forecast. */
  forecastRuns: number;
  /** Apply one op to a state, by the rules a save uses; throws when a save would refuse it. */
  apply: (state: PlanState, op: PlanOp) => PlanState;
  /** planProject calls allowed in one search. */
  budget?: number;
};

export type Evaluation = {
  state: PlanState;
  outcome: PlanOutcome;
  facts: PlanFacts;
  /** Open double-bookings this state makes that the starting plan did not have. */
  newClashes: number;
  clashes: number;
  late: number;
  finish: ISODate | null;
  forecast?: Forecast | null;
};

export type SuggestedMove = Omit<Move, 'key'>;

export type Effect = {
  finish: { before: ISODate | null; after: ISODate | null };
  late: { before: number; after: number };
  p80: { before: ISODate; after: ISODate } | null;
  on_time: { before: number | null; after: number | null } | null;
  clashes_cleared: { env_name: string; start_date: ISODate; end_date: ISODate; projects: string[] }[];
};

export type Profile = 'safe' | 'balanced' | 'aggressive';

export type Suggestion = {
  /** Stable for the same ops on the same plan. */
  id: string;
  profile: Profile | 'tidy';
  title: string;
  moves: SuggestedMove[];
  ops: PlanOp[];
  effect: Effect;
  /** The plan this was worked out on; applying to a changed plan is refused. */
  version: string;
};

export type Advice = { kind: 'M8' | 'M9'; title: string; text: string; task_ids: number[] };

export type SuggestionReport = {
  version: string;
  status_date: ISODate;
  suggestions: Suggestion[];
  tidy: Suggestion[];
  advice: Advice[];
  /** planProject calls the search made, of its budget. */
  evaluated: number;
  budget: number;
};

export const PROFILE_KINDS: Record<Profile, MoveKind[]> = {
  safe: ['M1', 'M2'],
  balanced: ['M1', 'M2', 'M4'],
  aggressive: ['M1', 'M2', 'M4', 'M3', 'M6', 'M7'],
};
const PROFILE_TITLE: Record<Profile, string> = { safe: 'Safe', balanced: 'Balanced', aggressive: 'Aggressive' };

export const BEAM_WIDTH = 3;
export const BEAM_DEPTH = 3;
export const CANDIDATES_PER_STEP = 40;
export const SEARCH_BUDGET = 500;
const FINALISTS = 3;

/** A short, stable fingerprint of what scheduling reads, so a suggestion knows the plan it was made for. */
export function planVersion(state: PlanState, project: { start_date?: ISODate | null; target_date?: ISODate | null }): string {
  const tasks = [...state.tasks].sort((a, b) => a.id - b.id).map((t) => [
    t.id, t.duration, t.status, t.not_before, t.environment_id, t.actual_start, t.actual_end, t.parent_id ?? null, t.progress ?? null,
    t.duration_low ?? null, t.duration_high ?? null, t.name,
  ]);
  const deps = [...state.deps].map((d) => [d.predecessor_id, d.successor_id, d.lag, d.type ?? 'FS']).sort();
  return seedOf(JSON.stringify([tasks, deps, project.start_date ?? null, project.target_date ?? null])).toString(36);
}

export function createSearch(ctx: SearchContext, start: PlanState) {
  const budget = Math.min(ctx.budget ?? SEARCH_BUDGET, 5000);
  let calls = 0;

  const outcomeOf = (s: PlanState) => {
    calls++;
    return planProject({ projectStart: ctx.projectStart, tasks: s.tasks, deps: s.deps, bookings: ctx.bookings, holidays: ctx.holidays });
  };

  const first = outcomeOf(start);
  if ('cycle' in first) return null;
  const base: PlanOutcome = first;

  const evaluate = (state: PlanState, outcome: PlanOutcome): Evaluation => {
    const conflicts = conflictsFor(outcome, ctx.impact);
    const facts = planFacts({
      project: ctx.project, projectStart: ctx.projectStart, outcome, baseline: ctx.baseline, people: ctx.people,
      conflicts, statusDate: ctx.statusDate, nearCriticalDays: ctx.nearCriticalDays, holidays: ctx.holidays,
    });
    return {
      state, outcome, facts,
      newClashes: outcome === base ? 0 : conflictChanges(base, outcome, ctx.impact).added.length,
      clashes: facts.clashes.length,
      late: facts.late_by,
      finish: facts.finish,
    };
  };
  const root = evaluate(start, base);

  /** Apply ops in order; null when a save would refuse one or the plan loops. */
  const tryOps = (from: PlanState, ops: readonly PlanOp[]): Evaluation | null => {
    let s = from;
    try {
      for (const op of ops) s = ctx.apply(s, op);
    } catch {
      return null;
    }
    const o = outcomeOf(s);
    return 'cycle' in o ? null : evaluate(s, o);
  };

  const withForecast = (e: Evaluation): Evaluation => {
    if (e.forecast !== undefined) return e;
    e.forecast = forecast({
      tasks: e.outcome.tasks, deps: e.outcome.deps, projectStart: ctx.projectStart, statusDate: ctx.statusDate,
      target: ctx.project.target_date, runs: ctx.forecastRuns, holidays: ctx.holidays,
      pace: new Map(e.facts.tasks.map((t) => [t.id, t.spi])),
    });
    return e;
  };

  const lateOf = (e: Evaluation) => (e.forecast && ctx.project.target_date ? lateBy(e.forecast.p80, ctx.project.target_date, ctx.holidays) : e.late);
  const p80Of = (e: Evaluation) => e.forecast?.p80 ?? e.finish ?? '';

  /** Lexicographic: negative when `a` is the better plan. */
  const compare = (a: Evaluation, b: Evaluation, disruption: (e: Evaluation) => number, useForecast: boolean) => {
    if (a.newClashes !== b.newClashes) return a.newClashes - b.newClashes;
    if (a.clashes !== b.clashes) return a.clashes - b.clashes;
    const la = useForecast ? lateOf(a) : a.late;
    const lb = useForecast ? lateOf(b) : b.late;
    if (la !== lb) return la - lb;
    if (useForecast && p80Of(a) !== p80Of(b)) return p80Of(a) < p80Of(b) ? -1 : 1;
    if ((a.finish ?? '') !== (b.finish ?? '')) return (a.finish ?? '') < (b.finish ?? '') ? -1 : 1;
    return disruption(a) - disruption(b);
  };

  /** Strictly better on the plan's risk, ignoring disruption. */
  const improves = (a: Evaluation, b: Evaluation, useForecast: boolean) => compare(a, b, () => 0, useForecast) < 0;

  type Node = { e: Evaluation; moves: Move[] };
  const disruptionOf = new Map<Evaluation, number>();
  const cost = (e: Evaluation) => disruptionOf.get(e) ?? 0;

  const context = (e: Evaluation) => ({
    facts: e.facts, tasks: e.state.tasks, deps: e.state.deps, environments: ctx.environments,
    bookings: bookingsFor(e.outcome, ctx.impact), longTaskDays: ctx.longTaskDays, holidays: ctx.holidays,
  });

  const candidates = (n: Node, kinds: readonly MoveKind[]): Move[] => {
    const used = new Set(n.moves.map((m) => m.key));
    const touched = new Set(n.moves.flatMap((m) => m.task_ids));
    // A created task is named by CREATED_ID until it is saved, so a path makes at most one.
    const created = n.moves.some((m) => m.ops.some((o) => o.op === 'create'));
    const c = context(n.e);
    const all = kinds.flatMap((k) => (k === 'M5' ? [] : GENERATORS[k](c)))
      .filter((m) => !used.has(m.key) && !m.task_ids.some((id) => touched.has(id) && m.kind !== 'M2'))
      .filter((m) => !created || !m.ops.some((o) => o.op === 'create'));
    // Cheapest disruption first, so the cap drops the costly moves.
    return all.sort((a, b) => DISRUPTION[a.kind] - DISRUPTION[b.kind] || a.key.localeCompare(b.key)).slice(0, CANDIDATES_PER_STEP);
  };

  /** One profile's beam: width BEAM_WIDTH, depth BEAM_DEPTH, within the shared budget. */
  const beam = (kinds: readonly MoveKind[], share: number): Node[] => {
    const stop = Math.min(budget, calls + share);
    let frontier: Node[] = [{ e: root, moves: [] }];
    const found: Node[] = [];
    for (let depth = 0; depth < BEAM_DEPTH && frontier.length; depth++) {
      const children: Node[] = [];
      for (const n of frontier) {
        for (const m of candidates(n, kinds)) {
          if (calls >= stop) break;
          const e = tryOps(n.e.state, m.ops);
          if (!e || e.newClashes > 0 || !improves(e, n.e, false)) continue;
          disruptionOf.set(e, cost(n.e) + DISRUPTION[m.kind]);
          children.push({ e, moves: [...n.moves, m] });
        }
      }
      children.sort((a, b) => compare(a.e, b.e, cost, false));
      const seen = new Set<string>();
      frontier = children.filter((c) => {
        const k = c.moves.map((m) => m.key).sort().join('|');
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      }).slice(0, BEAM_WIDTH);
      found.push(...frontier);
    }
    return found;
  };

  return { base, root, evaluate, tryOps, withForecast, improves, compare, beam, cost, calls: () => calls, budget, context };
}

/** Everything the assistant proposes for one plan: up to three alternative plans, tidy-ups and advice. */
export function suggest(ctx: SearchContext, start: PlanState, version: string): SuggestionReport | null {
  const search = createSearch(ctx, start);
  if (!search) return null;
  const { root } = search;
  search.withForecast(root);

  const profiles: Profile[] = ['safe', 'balanced', 'aggressive'];
  const shares: Record<Profile, number> = { safe: 0.3, balanced: 0.3, aggressive: 0.4 };
  const suggestions: Suggestion[] = [];
  const seen = new Set<string>();

  for (const profile of profiles) {
    const found = search.beam(PROFILE_KINDS[profile], Math.floor(search.budget * shares[profile]));
    // The best few by the plan's own dates, then ranked on the forecast.
    const finalists = [...found].sort((a, b) => search.compare(a.e, b.e, search.cost, false)).slice(0, FINALISTS);
    for (const f of finalists) search.withForecast(f.e);
    finalists.sort((a, b) => search.compare(a.e, b.e, search.cost, true));
    const best = finalists.find((f) => search.improves(f.e, root, true));
    if (!best) continue;
    const signature = best.moves.map((m) => m.key).sort().join('|');
    if (seen.has(signature)) continue;
    seen.add(signature);
    const ops = best.moves.flatMap((m) => m.ops);
    suggestions.push({
      id: seedOf(`${version}:${signature}`).toString(36),
      profile,
      title: `${PROFILE_TITLE[profile]}: ${headline(root, best.e)}`,
      moves: best.moves.map(({ key: _, ...m }) => m),
      ops,
      effect: effectOf(search, root, best.e, ctx),
      version,
    });
  }

  const tidy = redundantLinks(search.context(root)).slice(0, 5).map((m) => ({
    id: seedOf(`${version}:${m.key}`).toString(36),
    profile: 'tidy' as const,
    title: m.title,
    moves: [(({ key: _, ...rest }) => rest)(m)],
    ops: m.ops,
    effect: effectOf(search, root, root, ctx),
    version,
  }));

  return {
    version,
    status_date: ctx.statusDate,
    suggestions,
    tidy,
    advice: adviceFor(root, ctx),
    evaluated: search.calls(),
    budget: search.budget,
  };
}

type Search = NonNullable<ReturnType<typeof createSearch>>;

export function effectOf(search: Search, before: Evaluation, after: Evaluation, ctx: SearchContext): Effect {
  const fb = before.forecast;
  const fa = after === before ? fb : search.withForecast(after).forecast;
  return {
    finish: { before: before.finish, after: after.finish },
    late: { before: before.late, after: after.late },
    p80: fb && fa ? { before: fb.p80, after: fa.p80 } : null,
    on_time: fb && fa && ctx.project.target_date ? { before: fb.on_time, after: fa.on_time } : null,
    clashes_cleared: after === before ? [] : conflictChanges(before.outcome, after.outcome, ctx.impact).cleared,
  };
}

function headline(before: Evaluation, after: Evaluation): string {
  const parts: string[] = [];
  const cleared = before.clashes - after.clashes;
  if (cleared > 0) parts.push(`clears ${cleared} double-booking${cleared === 1 ? '' : 's'}`);
  const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
  if (before.finish && after.finish && after.finish < before.finish) parts.push(`finishes ${days(diffDays(after.finish, before.finish))} sooner`);
  const pb = before.forecast?.p80;
  const pa = after.forecast?.p80;
  if (pb && pa && pa < pb) parts.push(`P80 ${days(diffDays(pa, pb))} sooner`);
  const ob = before.forecast?.on_time;
  const oa = after.forecast?.on_time;
  if (ob != null && oa != null && oa > ob) parts.push(`on time ${Math.round(ob * 100)}% → ${Math.round(oa * 100)}%`);
  return parts.length ? parts.join(', ') : 'less risk';
}

function adviceFor(root: Evaluation, ctx: SearchContext): Advice[] {
  const out: Advice[] = [];
  const f = root.facts;
  for (const t of f.tasks) {
    if (t.summary || t.status !== 'blocked' || !(t.critical || t.near_critical)) continue;
    out.push({
      kind: 'M9',
      title: `Unblock ${label(t)}`,
      text: `It is blocked ${t.critical ? 'on the critical path: every day it stays blocked is a day on the finish' : `with ${t.total_float} days of float`}. Escalate whatever it waits on; no plan change makes up for it.`,
      task_ids: [t.id],
    });
  }
  const fc = root.forecast;
  const target = ctx.project.target_date;
  if (fc && target && fc.p80 > fc.p50) {
    const buffer = Math.max(1, workingBetween(fc.p50, fc.p80, ctx.holidays));
    out.push({
      kind: 'M8',
      title: `Hold ${buffer} working day${buffer === 1 ? '' : 's'} of buffer before the target`,
      text: `The P50 and P80 finishes are ${buffer} working day${buffer === 1 ? '' : 's'} apart. Critical Chain practice keeps that gap as one project buffer before the promise, rather than padding each task: plan to finish by the P50 (${day(fc.p50)}) and treat the time to ${day(target)} as buffer. `
        + (fc.p80 <= target ? `The P80 (${day(fc.p80)}) is inside the target, so the buffer fits.` : `The P80 (${day(fc.p80)}) is past the target, so the buffer does not fit: take a suggestion above, or agree a later promise.`),
      task_ids: [],
    });
  }
  return out;
}

function workingBetween(a: ISODate, b: ISODate, holidays?: HolidaySet): number {
  return lateBy(b, a, holidays);
}

