import { describe, expect, it } from 'vitest';
import { effectiveSpan, reconcileBookings, releaseFrom, taskHolds, type ReconcileBooking } from '../shared/taskHolds.ts';
import { planImpact, planProject, type PlanOutcome } from '../shared/plan.ts';
import type { BookingView, Environment, Task, TaskDependency } from '../shared/types.ts';

const SIT = 10;
const UAT = 11;

function task(id: number, start: string, end: string, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: SIT, name: `T${id}`, duration: 1, status: 'todo', not_before: null,
    assignee: null, note: null, sort_order: id, actual_start: null, actual_end: null,
    start_date: start, end_date: end, total_float: 0, critical: 0, ...partial,
  };
}

function manual(id: number, start: string, end: string, env = SIT): ReconcileBooking {
  return { id, environment_id: env, start_date: start, end_date: end, manual_start: start, manual_end: end };
}

function auto(id: number, start: string, end: string, env = SIT): ReconcileBooking {
  return { id, environment_id: env, start_date: start, end_date: end, manual_start: null, manual_end: null };
}

describe('taskHolds', () => {
  it('merges tasks up to two working days apart and splits past that', () => {
    // Fri 6 Mar end; Wed 11 Mar is two working days (Mon, Tue) later -> merge.
    const merged = taskHolds([task(1, '2026-03-02', '2026-03-06'), task(2, '2026-03-11', '2026-03-12')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ start: '2026-03-02', end: '2026-03-12', task_ids: [1, 2] });

    // Thu 12 Mar is three working days later -> a separate hold.
    const split = taskHolds([task(1, '2026-03-02', '2026-03-06'), task(2, '2026-03-12', '2026-03-13')]);
    expect(split).toHaveLength(2);
  });

  it('ignores tasks with no environment and milestones', () => {
    expect(taskHolds([task(1, '2026-03-02', '2026-03-06', { environment_id: null }), task(2, '2026-03-02', '2026-03-02', { duration: 0 })]))
      .toEqual([]);
  });

  it('uses actual dates for done tasks', () => {
    const [h] = taskHolds([task(1, '2026-03-02', '2026-03-13', { status: 'done', actual_start: '2026-03-02', actual_end: '2026-03-04' })]);
    expect(h).toMatchObject({ end: '2026-03-04', done: true });
  });

  it('keeps holds per environment', () => {
    const holds = taskHolds([task(1, '2026-03-02', '2026-03-06'), task(2, '2026-03-02', '2026-03-06', { environment_id: UAT })]);
    expect(holds.map((h) => h.environment_id)).toEqual([SIT, UAT]);
  });
});

describe('effectiveSpan: the longer wins', () => {
  it('keeps a manual booking longer than its tasks', () => {
    expect(effectiveSpan({ start: '2026-03-02', end: '2026-05-29' }, { start: '2026-03-02', end: '2026-04-30' }))
      .toEqual({ start: '2026-03-02', end: '2026-05-29' });
  });
  it('stretches a manual booking shorter than its tasks', () => {
    expect(effectiveSpan({ start: '2026-03-02', end: '2026-04-30' }, { start: '2026-02-23', end: '2026-05-29' }))
      .toEqual({ start: '2026-02-23', end: '2026-05-29' });
  });
});

describe('releaseFrom', () => {
  it('offers the day after the last done task when the booking runs on', () => {
    expect(releaseFrom('2026-03-20', { end: '2026-03-10', done: true })).toBe('2026-03-11');
    expect(releaseFrom('2026-03-20', { end: '2026-03-10', done: false })).toBeNull();
    expect(releaseFrom('2026-03-10', { end: '2026-03-10', done: true })).toBeNull();
  });
});

describe('reconcileBookings', () => {
  it('stretches the overlapping manual booking and leaves it alone otherwise', () => {
    const holds = taskHolds([task(1, '2026-03-05', '2026-03-13')]);
    const r = reconcileBookings([manual(1, '2026-03-02', '2026-03-06'), manual(2, '2026-04-01', '2026-04-03')], holds);
    expect(r.update.map((b) => [b.id, b.start_date, b.end_date])).toEqual([[1, '2026-03-02', '2026-03-13']]);
    expect(r.create).toEqual([]);
    expect(r.remove).toEqual([]);
  });

  it('shrinks back to the manual span when the tasks shrink', () => {
    const stretched = { ...manual(1, '2026-03-02', '2026-03-06'), end_date: '2026-03-13', hold_start: '2026-03-05', hold_end: '2026-03-13' };
    const r = reconcileBookings([stretched], taskHolds([task(1, '2026-03-03', '2026-03-04')]));
    expect(r.update[0]).toMatchObject({ start_date: '2026-03-02', end_date: '2026-03-06' });
  });

  it('makes an auto booking for a hold no manual booking covers', () => {
    const r = reconcileBookings([], taskHolds([task(1, '2026-03-02', '2026-03-06')]));
    expect(r.create).toEqual([expect.objectContaining({ id: null, start_date: '2026-03-02', end_date: '2026-03-06', manual_start: null })]);
  });

  it('keeps an auto booking’s id as its tasks move, and removes spare ones', () => {
    const r = reconcileBookings(
      [auto(7, '2026-03-02', '2026-03-06'), auto(8, '2026-06-01', '2026-06-05')],
      taskHolds([task(1, '2026-03-04', '2026-03-10')]),
    );
    expect(r.update.map((b) => b.id)).toEqual([7]);
    expect(r.remove).toEqual([8]);
  });

  it('attaches a hold to only the manual booking it overlaps most', () => {
    const r = reconcileBookings(
      [manual(1, '2026-03-02', '2026-03-03'), manual(2, '2026-03-05', '2026-03-13')],
      taskHolds([task(1, '2026-03-03', '2026-03-10')]),
    );
    const byId = new Map(r.bookings.map((b) => [b.id, b]));
    expect(byId.get(1)).toMatchObject({ end_date: '2026-03-03', hold_start: null });
    expect(byId.get(2)).toMatchObject({ start_date: '2026-03-03', end_date: '2026-03-13' });
  });
});

describe('planImpact', () => {
  const env: Environment = { id: SIT, team_id: 1, name: 'SIT', kind: 'SIT', capacity: 1, sort_order: 0 };
  const other: BookingView = {
    id: 99, project_id: 2, environment_id: SIT, kind: 'SIT', start_date: '2026-03-16', end_date: '2026-03-20',
    confidence: 'committed', optional: 0, note: null, marker: null, project_name: 'Billing', team_id: 1,
    priority: 'normal', env_name: 'SIT', env_kind: 'SIT', capacity: 1, calendar_days: 5, working_days: 5,
    is_milestone: false,
  };
  const t = (id: number, duration: number, envId: number | null = SIT): Task =>
    ({ ...task(id, '', '', { duration, environment_id: envId }), start_date: null, end_date: null });
  const plan = (tasks: Task[], deps: TaskDependency[]) =>
    planProject({ projectStart: '2026-03-02', tasks, deps, bookings: [] }) as PlanOutcome;
  const ctx = {
    project: { id: 1, name: 'Payments', priority: 'high' as const, target_date: '2026-03-13' },
    teamBookings: [other], environments: [env], resolved: new Set<string>(),
  };

  it('flags a change that makes a double-booking as high risk', () => {
    const before = plan([t(1, 5), t(2, 5, null)], [{ predecessor_id: 1, successor_id: 2, lag: 0 }]);
    const after = plan([t(1, 12), t(2, 5, null)], [{ predecessor_id: 1, successor_id: 2, lag: 0 }]);
    const impact = planImpact(before, after, ctx);
    expect(impact.risk).toBe('high');
    expect(impact.conflicts_added).toEqual([expect.objectContaining({ env_name: 'SIT', projects: expect.arrayContaining(['Billing']) })]);
    expect(impact.bookings[0].change).toBe('created');
    expect(impact.finish.days).toBeGreaterThan(0);
  });

  it('lists successors that lose a predecessor when a critical task is deleted', () => {
    const deps = [{ predecessor_id: 1, successor_id: 2, lag: 0 }];
    const before = plan([t(1, 3, null), t(2, 2, null)], deps);
    const after = plan([t(2, 2, null)], []);
    const impact = planImpact(before, after, { ...ctx, deletedTaskId: 1 });
    expect(impact.unlinked).toEqual([{ id: 2, name: 'T2' }]);
    expect(impact.risk).toBe('high');
    expect(impact.moved).toEqual([expect.objectContaining({ id: 2, days: -3 })]);
  });

  it('names a dependency loop', () => {
    const before = plan([t(1, 1, null), t(2, 1, null)], [{ predecessor_id: 1, successor_id: 2, lag: 0 }]);
    const after = planProject({ projectStart: '2026-03-02', tasks: before.tasks, bookings: [],
      deps: [{ predecessor_id: 1, successor_id: 2, lag: 0 }, { predecessor_id: 2, successor_id: 1, lag: 0 }] });
    expect(planImpact(before, after, ctx).cycle).toEqual(expect.arrayContaining(['T1', 'T2']));
  });
});
