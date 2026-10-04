import { describe, expect, it } from 'vitest';
import { planProject, type ImpactContext } from '../shared/plan.ts';
import { CREATED_ID, type PlanOp } from '../shared/assistant/moves.ts';
import { type PlanState, type SearchContext } from '../shared/assistant/optimise.ts';
import { buildReview, workingShift, type PlanReview } from '../shared/assistant/review.ts';
import type { ReconcileBooking } from '../shared/taskHolds.ts';
import type { BookingView, Environment, Task, TaskDependency } from '../shared/types.ts';

// 2026-03-02 is a Monday.
const MON = '2026-03-02';

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name: `T${id}`, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null, code: id,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}
const dep = (predecessor_id: number, successor_id: number, lag = 0): TaskDependency => ({ predecessor_id, successor_id, lag, type: 'FS' });
const env = (id: number): Environment => ({ id, team_id: 1, name: `SIT-${id}`, kind: 'SIT', capacity: 1, sort_order: id });

function booking(id: number, project_id: number, environment_id: number, start: string, end: string): BookingView {
  return {
    id, project_id, environment_id, kind: 'SIT', start_date: start, end_date: end, confidence: 'committed', optional: 0,
    note: null, marker: null, project_name: project_id === 1 ? 'Plan' : 'Other', team_id: 1, priority: 'high',
    env_name: `SIT-${environment_id}`, env_kind: 'SIT', capacity: 1, calendar_days: 3, working_days: 3, is_milestone: false,
  } as BookingView;
}

/** The ops as the server's applyChange takes them, for the fields these tests use. */
function apply(s: PlanState, op: PlanOp): PlanState {
  const tasks = [...s.tasks];
  let deps = [...s.deps];
  if (op.op !== 'update') throw new Error('Only updates in these tests');
  const i = tasks.findIndex((t) => t.id === op.id);
  if (i < 0) throw new Error('Task not found');
  const { predecessors, ...rest } = op.fields;
  tasks[i] = { ...tasks[i], ...rest };
  if (predecessors) {
    deps = deps.filter((d) => d.successor_id !== op.id)
      .concat(predecessors.map((p) => ({ predecessor_id: p.id, successor_id: op.id, lag: p.lag, type: p.type })));
  }
  return { tasks, deps };
}

function context(o: {
  environments?: Environment[]; team?: BookingView[]; mine?: ReconcileBooking[]; people?: Map<number, number[]>; target?: string;
} = {}): SearchContext {
  const project = { id: 1, name: 'Plan', priority: 'normal' as const, target_date: o.target ?? null };
  const environments = o.environments ?? [];
  const impact: ImpactContext = { project, teamBookings: o.team ?? [], environments, resolved: new Set() };
  return {
    project, projectStart: MON, statusDate: MON, bookings: o.mine ?? [], impact, environments,
    people: o.people ?? new Map(), baseline: new Map(), nearCriticalDays: 2, longTaskDays: 20, forecastRuns: 50, apply,
  };
}

const opts = { version: 'v', elsewhere: [], names: new Map([[9, 'Mai']]) };
const review = (ctx: SearchContext, s: PlanState, ops: PlanOp[]) => {
  const r = buildReview(ctx, s, ops, opts);
  if ('refused' in r) throw new Error(r.refused);
  return r as PlanReview;
};

describe('reviewing a suggestion', () => {
  it('counts shifts in working days, so a weekend is not a move', () => {
    expect(workingShift('2026-03-06', '2026-03-09')).toBe(1); // Friday to Monday
    expect(workingShift('2026-03-09', '2026-03-06')).toBe(-1);
    expect(workingShift(MON, MON)).toBe(0);
  });

  it('finds nothing to report for no change', () => {
    const r = review(context(), { tasks: [task(1, 3), task(2, 2)], deps: [dep(1, 2)] }, [
      { op: 'update', id: 1, fields: { name: 'T1' } },
    ]);
    expect(r.diff.tasks).toEqual([]);
    expect(r.diff.unchanged).toBe(2);
    expect(r.verdict.worse).toEqual([]);
    expect(r.verdict.better).toEqual([]);
    expect(r.verdict.same).toMatch(/^0 tasks change; 2 stay as they are\. The finish stays/);
  });

  it('reports a moved task, and what follows it, in working days', () => {
    const r = review(context(), { tasks: [task(1, 3), task(2, 2)], deps: [dep(1, 2)] }, [
      { op: 'update', id: 1, fields: { not_before: '2026-03-09' } },
    ]);
    const t1 = r.diff.tasks.find((t) => t.id === 1)!;
    expect(t1.start).toBe(5);
    expect(t1.finish).toBe(5);
    expect(t1.not_before).toEqual({ before: null, after: '2026-03-09' });
    expect(r.diff.tasks.find((t) => t.id === 2)!.start).toBe(5);
    expect(r.diff.finish.days).toBe(5);
    expect(r.verdict.worse[0]).toMatch(/^Finishes .*5 working days later\.$/);
  });

  it('shows the plan Apply would write: the same dates as planning the applied state', () => {
    const ctx = context();
    const s: PlanState = { tasks: [task(1, 3), task(2, 4), task(3, 1)], deps: [dep(1, 3), dep(2, 3)] };
    const ops: PlanOp[] = [{ op: 'update', id: 2, fields: { duration: 6 } }];
    const r = review(ctx, s, ops);
    const applied = ops.reduce(apply, s);
    const planned = planProject({ projectStart: MON, tasks: applied.tasks, deps: applied.deps, bookings: [] });
    if ('cycle' in planned) throw new Error('loop');
    for (const t of planned.tasks) {
      const shown = r.after.tasks.find((x) => x.id === t.id)!;
      expect([shown.start, shown.end]).toEqual([t.start_date, t.end_date]);
    }
  });

  it('names a double-booking cleared, and one opened as worse', () => {
    const team = [booking(100, 2, 7, MON, '2026-03-04')];
    const ctx = context({ environments: [env(7)], team });
    const clashing: PlanState = { tasks: [task(1, 2, { environment_id: 7 })], deps: [] };
    const cleared = review(ctx, clashing, [{ op: 'update', id: 1, fields: { not_before: '2026-03-05' } }]);
    expect(cleared.diff.clashes_cleared).toHaveLength(1);
    expect(cleared.diff.clashes_opened).toHaveLength(0);
    expect(cleared.diff.environment_ids).toEqual([7]);
    expect(cleared.verdict.better.some((l) => l.startsWith('Clears the SIT-7 double-booking with Other'))).toBe(true);
    expect(cleared.before.conflicts).toHaveLength(1);
    expect(cleared.after.conflicts).toHaveLength(0);

    const free: PlanState = { tasks: [task(1, 2, { environment_id: 7, not_before: '2026-03-05' })], deps: [] };
    const opened = review(ctx, free, [{ op: 'update', id: 1, fields: { not_before: null } }]);
    expect(opened.diff.clashes_opened).toHaveLength(1);
    expect(opened.verdict.worse[0]).toMatch(/^Double-books SIT-7 2 Mar – 3 Mar with Other\.$/);
  });

  it('shows an auto booking that keeps its id as moved, not as removed and created', () => {
    const mine: ReconcileBooking[] = [{ id: 50, environment_id: 7, start_date: MON, end_date: '2026-03-04', manual_start: null, manual_end: null, hold_start: MON, hold_end: '2026-03-04' }];
    const ctx = context({ environments: [env(7)], mine, team: [booking(50, 1, 7, MON, '2026-03-04')] });
    const r = review(ctx, { tasks: [task(1, 3, { environment_id: 7 })], deps: [] }, [
      { op: 'update', id: 1, fields: { not_before: '2026-03-09' } },
    ]);
    expect(r.diff.bookings.map((b) => [b.id, b.change])).toEqual([[50, 'moved']]);
  });

  it('names a person’s overlap that a link clears', () => {
    const ctx = context({ people: new Map([[1, [9]], [2, [9]]]) });
    const r = review(ctx, { tasks: [task(1, 3), task(2, 3)], deps: [] }, [
      { op: 'update', id: 2, fields: { predecessors: [{ id: 1, lag: 0, type: 'FS' }] } },
    ]);
    expect(r.before.overlaps).toHaveLength(1);
    expect(r.after.overlaps).toHaveLength(0);
    expect(r.diff.overlaps_cleared.map((x) => x.name)).toEqual(['Mai']);
    expect(r.diff.resource_ids).toEqual([9]);
    expect(r.verdict.better).toContain('Mai is no longer on T1 (T1) and T2 (T2) at once.');
    expect(r.diff.tasks.find((t) => t.id === 2)!.links).toBe(true);
  });

  it('names a deadline the change makes it miss, and one it now meets', () => {
    // T1 Mon–Wed 4 Mar, due Thu 5 Mar.
    const s: PlanState = { tasks: [task(1, 3, { deadline: '2026-03-05' })], deps: [] };
    const r = review(context(), s, [{ op: 'update', id: 1, fields: { duration: 6 } }]);
    expect(r.diff.tasks[0].deadline).toEqual({ change: 'missed', date: '2026-03-05', days: 2 });
    expect(r.verdict.worse).toContain('T1 (T1) misses its deadline of 5 Mar by 2 working days.');
    expect(r.after.tasks[0]).toMatchObject({ deadline: '2026-03-05', deadline_slack: -2 });

    const back = review(context(), { tasks: [task(1, 6, { deadline: '2026-03-05' })], deps: [] }, [{ op: 'update', id: 1, fields: { duration: 3 } }]);
    expect(back.verdict.better).toContain('T1 (T1) now meets its deadline of 5 Mar.');
  });

  it('says what a change does to the plan’s cost, when anything is costed', () => {
    const ctx = context({ people: new Map([[1, [9]], [2, [9]]]) });
    const s: PlanState = { tasks: [task(1, 5), task(2, 2, { fixed_cost: 50 })], deps: [] };
    const costed = buildReview(ctx, s, [{ op: 'update', id: 1, fields: { duration: 3 } }], { ...opts, rates: new Map([[9, 100]]), currency: 'EUR' });
    if ('refused' in costed) throw new Error(costed.refused);
    expect(costed.diff.cost).toEqual({ before: 750, after: 550, currency: 'EUR', tasks: [{ id: 1, label: 'T1 (T1)', before: 500, after: 300 }] });
    expect(costed.verdict.better).toContain('Costs €200 less to deliver: €750 → €550.');
    // Nothing costed: no Budget view at all.
    expect(review(context(), { tasks: [task(1, 5)], deps: [] }, [{ op: 'update', id: 1, fields: { duration: 3 } }]).diff.cost).toBeNull();
  });

  it('refuses, with the save’s reason, an op a save would refuse', () => {
    const r = buildReview(context(), { tasks: [task(1, 1)], deps: [] }, [{ op: 'update', id: CREATED_ID, fields: { duration: 2 } }], opts);
    expect(r).toEqual({ refused: 'Task not found' });
  });

  it('refuses ops that make a loop', () => {
    const r = buildReview(context(), { tasks: [task(1, 1), task(2, 1)], deps: [dep(1, 2)] }, [
      { op: 'update', id: 1, fields: { predecessors: [{ id: 2, lag: 0, type: 'FS' }] } },
    ], opts);
    expect(r).toEqual({ refused: 'These changes would make a dependency loop.' });
  });
});
