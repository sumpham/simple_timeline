import { describe, expect, it } from 'vitest';
import { conflictChanges, planProject, type ImpactContext } from '../shared/plan.ts';
import { lateBy } from '../shared/schedule.ts';
import { forecast } from '../shared/assistant/forecast.ts';
import { CREATED_ID, redundantLinks, type PlanOp } from '../shared/assistant/moves.ts';
import { createSearch, planVersion, suggest, PROFILE_KINDS, type PlanState, type SearchContext } from '../shared/assistant/optimise.ts';
import { planFacts } from '../shared/assistant/facts.ts';
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
const dep = (predecessor_id: number, successor_id: number, lag = 0): TaskDependency => ({ predecessor_id, successor_id, lag, type: 'FS' });
const env = (id: number, kind: Environment['kind'] = 'SIT'): Environment => ({ id, team_id: 1, name: `${kind}-${id}`, kind, capacity: 1, sort_order: id });

function other(id: number, environment_id: number, start: string, end: string): BookingView {
  return {
    id, project_id: 2, environment_id, kind: 'SIT', start_date: start, end_date: end, confidence: 'committed', optional: 0,
    note: null, marker: null, project_name: 'Other', team_id: 1, priority: 'high', env_name: `SIT-${environment_id}`,
    env_kind: 'SIT', capacity: 1, calendar_days: 3, working_days: 3, is_milestone: false,
  } as BookingView;
}

/** The ops as the server's applyChange takes them, for the few fields moves use. */
function apply(s: PlanState, op: PlanOp): PlanState {
  let tasks = [...s.tasks];
  let deps = [...s.deps];
  const setPreds = (id: number, preds?: { id: number; lag: number; type: TaskDependency['type'] }[]) => {
    if (!preds) return;
    deps = deps.filter((d) => d.successor_id !== id).concat(preds.map((p) => ({ predecessor_id: p.id, successor_id: id, lag: p.lag, type: p.type })));
  };
  if (op.op === 'update') {
    const i = tasks.findIndex((t) => t.id === op.id);
    if (i < 0) throw new Error('Task not found');
    const { predecessors, ...rest } = op.fields;
    tasks[i] = { ...tasks[i], ...rest };
    setPreds(op.id, predecessors);
  } else if (op.op === 'create') {
    const { predecessors, ...rest } = op.fields;
    tasks.push(task(CREATED_ID, 1, { ...rest, code: 999, sort_order: tasks.length }));
    setPreds(CREATED_ID, predecessors);
  } else {
    tasks = tasks.filter((t) => t.id !== op.id);
    deps = deps.filter((d) => d.predecessor_id !== op.id && d.successor_id !== op.id);
  }
  return { tasks, deps };
}

function context(o: { environments: Environment[]; others?: BookingView[]; target?: string | null; longTaskDays?: number }): SearchContext {
  const project = { id: 1, name: 'Plan', priority: 'normal' as const, target_date: o.target ?? null };
  const impact: ImpactContext = { project, teamBookings: o.others ?? [], environments: o.environments, resolved: new Set() };
  return {
    project, projectStart: MON, statusDate: MON, bookings: [], impact, environments: o.environments,
    people: new Map(), baseline: new Map(), nearCriticalDays: 2, longTaskDays: o.longTaskDays ?? 20, forecastRuns: 200, apply,
  };
}

const state = (tasks: Task[], deps: TaskDependency[] = []): PlanState => ({ tasks, deps });

describe('better plans', () => {
  it('levels a task with float past another project’s booking, finish unchanged (M1)', () => {
    const ctx = context({ environments: [env(7)], others: [other(100, 7, MON, '2026-03-04')] });
    const s = state([task(1, 10), task(2, 3, { environment_id: 7 }), task(3, 1)], [dep(1, 3), dep(2, 3)]);
    const r = suggest(ctx, s, 'v')!;
    const safe = r.suggestions.find((x) => x.profile === 'safe')!;
    expect(safe.moves.map((m) => m.kind)).toEqual(['M1']);
    expect(safe.ops).toEqual([{ op: 'update', id: 2, fields: { not_before: '2026-03-05' } }]);
    expect(safe.effect.finish.before).toBe(safe.effect.finish.after);
    expect(safe.effect.clashes_cleared).toHaveLength(1);
  });

  it('switches a critical task to a free environment of the same kind (M2)', () => {
    const ctx = context({ environments: [env(7), env(8), env(9, 'UAT')], others: [other(100, 7, MON, '2026-03-04')] });
    const s = state([task(1, 3, { environment_id: 7 }), task(2, 2)], [dep(1, 2)]);
    const safe = suggest(ctx, s, 'v')!.suggestions.find((x) => x.profile === 'safe')!;
    expect(safe.ops).toEqual([{ op: 'update', id: 1, fields: { environment_id: 8 } }]);
  });

  it('keeps trade-off moves out of the safe plan, and clears a driving date only from balanced up (M4)', () => {
    const ctx = context({ environments: [] });
    const s = state([task(1, 2), task(2, 5, { not_before: '2026-03-16' })], [dep(1, 2)]);
    const r = suggest(ctx, s, 'v')!;
    expect(r.suggestions.find((x) => x.profile === 'safe')).toBeUndefined();
    const balanced = r.suggestions.find((x) => x.profile === 'balanced')!;
    expect(balanced.moves.map((m) => m.kind)).toEqual(['M4']);
    expect(balanced.effect.finish.after! < balanced.effect.finish.before!).toBe(true);
    for (const x of r.suggestions) {
      for (const m of x.moves) expect(PROFILE_KINDS[x.profile as 'safe'].includes(m.kind)).toBe(true);
      for (const m of x.moves) if (m.kind === 'M3' || m.kind === 'M6' || m.kind === 'M7') expect(m.tradeoff).toBeTruthy();
    }
  });

  it('compresses a critical path only in the aggressive plan (M3, M6, M7)', () => {
    const ctx = context({ environments: [], longTaskDays: 8 });
    const s = state([task(1, 10), task(2, 6), task(3, 1)], [dep(1, 2), dep(2, 3)]);
    const r = suggest(ctx, s, 'v')!;
    expect(r.suggestions.map((x) => x.profile)).toEqual(['aggressive']);
    const kinds = r.suggestions[0].moves.map((m) => m.kind);
    expect(kinds.every((k) => ['M3', 'M6', 'M7'].includes(k))).toBe(true);
    expect(r.suggestions[0].effect.finish.after! < r.suggestions[0].effect.finish.before!).toBe(true);
  });

  it('splits a long task into two, with what follows waiting on the first part (M7)', () => {
    const ctx = context({ environments: [], longTaskDays: 8 });
    const search = createSearch(ctx, state([task(1, 10), task(2, 2)], [dep(1, 2)]))!;
    const m = search.context(search.root);
    const e = search.tryOps(search.root.state, [
      { op: 'update', id: 1, fields: { duration: 5, name: 'T1 (part 1)' } },
      { op: 'create', fields: { name: 'T1 (part 2)', duration: 5, predecessors: [{ id: 1, lag: 0, type: 'FS' }] }, after_id: 1 },
    ])!;
    expect(m.facts.finish).toBe('2026-03-17');
    expect(e.facts.byId.get(CREATED_ID)!.start).toBe('2026-03-09');
    expect(e.facts.byId.get(2)!.start).toBe('2026-03-09');
  });

  it('finds links other links already imply (M5), and only those', () => {
    const s = state([task(1, 2), task(2, 2), task(3, 2), task(4, 2)], [dep(1, 2), dep(2, 3), dep(1, 3), dep(3, 4)]);
    const o = planProject({ projectStart: MON, tasks: s.tasks, deps: s.deps, bookings: [] });
    if ('cycle' in o) throw new Error();
    const facts = planFacts({
      project: { id: 1, name: 'P', priority: 'normal' }, projectStart: MON, outcome: o, baseline: new Map(), people: new Map(),
      conflicts: [], statusDate: MON, nearCriticalDays: 2,
    });
    const moves = redundantLinks({ facts, tasks: s.tasks, deps: s.deps, environments: [], bookings: [], longTaskDays: 20 });
    expect(moves.map((m) => m.key)).toEqual(['M5:1>3']);
    expect(moves[0].ops).toEqual([{ op: 'update', id: 3, fields: { predecessors: [{ id: 2, lag: 0, type: 'FS' }] } }]);
  });

  it('never proposes a plan that makes a new double-booking or a later P80, on random plans', () => {
    const r = seededRandom(5);
    let checked = 0;
    for (let n = 0; n < 25; n++) {
      const envs = [env(7), env(8), env(9, 'UAT')];
      const count = 4 + Math.floor(r() * 8);
      const tasks = Array.from({ length: count }, (_, i) => task(i + 1, 1 + Math.floor(r() * 8), {
        environment_id: r() < 0.6 ? envs[Math.floor(r() * 3)].id : null,
        not_before: r() < 0.15 ? `2026-03-${String(10 + Math.floor(r() * 10)).padStart(2, '0')}` : null,
      }));
      const deps: TaskDependency[] = [];
      for (let i = 2; i <= count; i++) if (r() < 0.7) deps.push(dep(1 + Math.floor(r() * (i - 1)), i));
      const others = Array.from({ length: 3 }, (_, i) => {
        const start = 2 + Math.floor(r() * 15);
        return other(100 + i, envs[Math.floor(r() * 3)].id, `2026-03-${String(start).padStart(2, '0')}`, `2026-03-${String(start + 1 + Math.floor(r() * 4)).padStart(2, '0')}`);
      });
      const ctx = context({ environments: envs, others, target: '2026-03-20', longTaskDays: 6 });
      const s = state(tasks, deps);
      const report = suggest(ctx, s, 'v');
      if (!report) continue;
      expect(report.evaluated).toBeLessThanOrEqual(report.budget);
      const before = planProject({ projectStart: MON, tasks, deps, bookings: [] });
      if ('cycle' in before) continue;
      const fBefore = forecast({ tasks: before.tasks, deps, projectStart: MON, statusDate: MON, target: '2026-03-20', runs: 200 })!;
      for (const sug of report.suggestions) {
        let after = s;
        for (const op of sug.ops) after = apply(after, op);
        const o = planProject({ projectStart: MON, tasks: after.tasks, deps: after.deps, bookings: [] });
        if ('cycle' in o) throw new Error('a suggestion made a loop');
        expect(conflictChanges(before, o, ctx.impact).added).toEqual([]);
        const fAfter = forecast({ tasks: o.tasks, deps: after.deps, projectStart: MON, statusDate: MON, target: '2026-03-20', runs: 200 })!;
        expect(lateBy(fAfter.p80, '2026-03-20')).toBeLessThanOrEqual(lateBy(fBefore.p80, '2026-03-20'));
        expect(sug.effect.finish.after).toBe(tasks.length ? o.schedule.finish : null);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(10);
  });

  it('says what the plan version was, and changes it when the plan changes', () => {
    const a = planVersion(state([task(1, 3)]), { target_date: null });
    expect(planVersion(state([task(1, 3)]), { target_date: null })).toBe(a);
    expect(planVersion(state([task(1, 4)]), { target_date: null })).not.toBe(a);
    expect(planVersion(state([task(1, 3)]), { target_date: '2026-04-01' })).not.toBe(a);
  });

  it('advises unblocking critical work and sizes a buffer from the forecast', () => {
    const ctx = context({ environments: [], target: '2026-04-30' });
    const r = suggest(ctx, state([task(1, 5), task(2, 5, { status: 'blocked' })], [dep(1, 2)]), 'v')!;
    expect(r.advice.map((a) => a.kind).sort()).toEqual(['M8', 'M9']);
    expect(r.advice.find((a) => a.kind === 'M8')!.text).toContain('buffer fits');
  });
});
