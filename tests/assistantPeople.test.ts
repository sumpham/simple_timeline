import { describe, expect, it } from 'vitest';
import { conflictChanges, planProject, type ImpactContext } from '../shared/plan.ts';
import { type PlanOp } from '../shared/assistant/moves.ts';
import { suggest, type PlanState, type SearchContext } from '../shared/assistant/optimise.ts';
import { planFacts, type ElsewhereWork } from '../shared/assistant/facts.ts';
import { assess } from '../shared/assistant/rules.ts';
import { seededRandom } from '../shared/assistant/random.ts';
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
const dep = (predecessor_id: number, successor_id: number): TaskDependency => ({ predecessor_id, successor_id, lag: 0, type: 'FS' });
const env = (id: number): Environment => ({ id, team_id: 1, name: `SIT-${id}`, kind: 'SIT', capacity: 1, sort_order: id });
function other(id: number, environment_id: number, start: string, end: string): BookingView {
  return {
    id, project_id: 2, environment_id, kind: 'SIT', start_date: start, end_date: end, confidence: 'committed', optional: 0,
    note: null, marker: null, project_name: 'Other', team_id: 1, priority: 'high', env_name: `SIT-${environment_id}`,
    env_kind: 'SIT', capacity: 1, calendar_days: 3, working_days: 3, is_milestone: false,
  } as BookingView;
}

function apply(s: PlanState, op: PlanOp): PlanState {
  if (op.op !== 'update') throw new Error('updates only');
  const tasks = [...s.tasks];
  const i = tasks.findIndex((t) => t.id === op.id);
  if (i < 0) throw new Error('Task not found');
  const { predecessors: _, ...rest } = op.fields;
  tasks[i] = { ...tasks[i], ...rest };
  return { tasks, deps: s.deps };
}

const NAMES = new Map([[9, 'Mai'], [8, 'Tuan']]);

function context(o: { people: Record<number, number[]>; environments?: Environment[]; others?: BookingView[]; elsewhere?: ElsewhereWork[] }): SearchContext {
  const project = { id: 1, name: 'Plan', priority: 'normal' as const, target_date: null };
  const environments = o.environments ?? [];
  const impact: ImpactContext = { project, teamBookings: o.others ?? [], environments, resolved: new Set() };
  return {
    project, projectStart: MON, statusDate: MON, bookings: [], impact, environments,
    people: new Map(Object.entries(o.people).map(([k, v]) => [Number(k), v])), baseline: new Map(),
    nearCriticalDays: 2, longTaskDays: 20, forecastRuns: 100, apply, elsewhere: o.elsewhere, names: NAMES,
  };
}

function facts(ctx: SearchContext, s: PlanState) {
  const outcome = planProject({ projectStart: MON, tasks: s.tasks, deps: s.deps, bookings: [] });
  if ('cycle' in outcome) throw new Error('cycle');
  return planFacts({
    project: ctx.project, projectStart: MON, outcome, baseline: new Map(), people: ctx.people, conflicts: [],
    statusDate: MON, nearCriticalDays: 2, elsewhere: ctx.elsewhere,
  });
}

describe('people on two tasks at once', () => {
  // T1 (10d) sets the finish; T2 (3d) and T3 (3d) run in parallel at the start, both Mai's.
  const s: PlanState = { tasks: [task(1, 10), task(2, 3), task(3, 3)], deps: [] };
  const ctx = context({ people: { 2: [9], 3: [9] } });

  it('are facts, counted in working days, here and in other plans', () => {
    const f = facts(ctx, s);
    expect(f.overlaps.map((o) => [o.resource_id, o.a, o.b, o.days])).toEqual([[9, 2, 3, 3]]);
    expect(f.overlap_days).toBe(3);
    const away = context({ people: { 2: [9] }, elsewhere: [{ task_id: 50, project_id: 2, resource_ids: [9], start: '2026-03-03', end: '2026-03-10', name: 'Partner API', code: 4, project_name: 'Payments' }] });
    const g = facts(away, { tasks: [task(1, 10), task(2, 3)], deps: [] });
    expect(g.overlaps.map((o) => [o.a, o.b, o.days])).toEqual([[2, 50, 2]]);
    expect(g.overlaps[0].spans[50]).toMatchObject({ here: false, project_name: 'Payments' });
  });

  it('raise H7, naming the person and the other plan; S5 keeps two critical tasks', () => {
    const away = context({ people: { 2: [9] }, elsewhere: [{ task_id: 50, project_id: 2, resource_ids: [9], start: '2026-03-03', end: '2026-03-10', name: 'Partner API', code: 4, project_name: 'Payments' }] });
    const [h7] = assess(facts(away, { tasks: [task(1, 10), task(2, 3)], deps: [] }), { long_task_days: 20 }, NAMES).filter((f) => f.rule === 'H7');
    expect(h7.key).toBe('H7:9:2:50');
    expect(h7.text).toBe('Mai is on T2 (T2) and Partner API (in Payments) at once for 2 working days, 3 Mar – 4 Mar. The dates assume both get done in those days.');
    const critical = assess(facts(context({ people: { 1: [9], 2: [9] } }), { tasks: [task(1, 3), task(2, 3)], deps: [] }), { long_task_days: 20 }, NAMES);
    expect(critical.filter((f) => f.rule === 'H7')).toEqual([]);
    expect(critical.filter((f) => f.rule === 'S5')).toHaveLength(1);
  });

  it('are levelled within float, finish unchanged (ML), even in the safe profile', () => {
    const r = suggest(ctx, s, 'v')!;
    const safe = r.suggestions.find((x) => x.profile === 'safe')!;
    expect(safe.moves.map((m) => m.kind)).toEqual(['ML']);
    expect(safe.moves[0].reason).toMatch(/^Mai is on T\d \(T\d\) and T\d \(T\d\) at once for 3 working days/);
    expect(safe.moves[0].tradeoff).toBeNull();
    expect(safe.effect.finish.before).toBe(safe.effect.finish.after);
    expect(safe.title).toMatch(/frees 3 days of people on two tasks at once/);
  });

  it('are levelled past float only in the aggressive profile, with the trade-off said (MLX)', () => {
    const tight = context({ people: { 1: [9], 2: [9] } });
    // T1 is critical; T2 has 1 day of float: waiting for T1 costs the finish.
    const r = suggest(tight, { tasks: [task(1, 4), task(2, 3)], deps: [] }, 'v', { only: 'people' })!;
    expect(r.suggestions.map((x) => x.profile)).toEqual(['aggressive']);
    const m = r.suggestions[0].moves[0];
    expect(m.kind).toBe('MLX');
    expect(m.tradeoff).toMatch(/the finish can move by up to/);
  });

  it('never trades a person for a double-booking, and ML never moves the finish, on random plans', () => {
    const r = seededRandom(11);
    let checked = 0;
    for (let n = 0; n < 25; n++) {
      const envs = [env(7), env(8)];
      const count = 4 + Math.floor(r() * 7);
      const tasks = Array.from({ length: count }, (_, i) => task(i + 1, 1 + Math.floor(r() * 6), {
        environment_id: r() < 0.5 ? envs[Math.floor(r() * 2)].id : null,
      }));
      const deps: TaskDependency[] = [];
      for (let i = 2; i <= count; i++) if (r() < 0.5) deps.push(dep(1 + Math.floor(r() * (i - 1)), i));
      const people: Record<number, number[]> = {};
      for (const t of tasks) if (r() < 0.7) people[t.id] = [r() < 0.5 ? 9 : 8];
      const others = [other(100, envs[0].id, '2026-03-05', '2026-03-09'), other(101, envs[1].id, '2026-03-10', '2026-03-12')];
      const c = context({ people, environments: envs, others });
      const st: PlanState = { tasks, deps };
      const report = suggest(c, st, 'v', { only: 'people' });
      if (!report) continue;
      const before = planProject({ projectStart: MON, tasks, deps, bookings: [] });
      if ('cycle' in before) continue;
      const fb = facts(c, st);
      for (const sug of report.suggestions) {
        let after = st;
        for (const op of sug.ops) after = apply(after, op);
        const o = planProject({ projectStart: MON, tasks: after.tasks, deps: after.deps, bookings: [] });
        if ('cycle' in o) throw new Error('a suggestion made a loop');
        expect(conflictChanges(before, o, c.impact).added).toEqual([]);
        expect(facts(c, after).overlap_days).toBeLessThan(fb.overlap_days);
        if (sug.moves.every((m) => m.kind === 'ML')) expect(o.schedule.finish).toBe(before.schedule.finish);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(8);
  });
});
