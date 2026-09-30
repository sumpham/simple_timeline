import { describe, expect, it } from 'vitest';
import { planProject } from '../shared/plan.ts';
import { planFacts, type PlanFacts } from '../shared/assistant/facts.ts';
import { assess, type Finding, type RuleId } from '../shared/assistant/rules.ts';
import type { Conflict, ISODate, Priority, Task, TaskDependency } from '../shared/types.ts';

// 2026-03-02 is a Monday.
const MON = '2026-03-02';

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name: `T${id}`, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null, code: id,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}
const dep = (predecessor_id: number, successor_id: number, lag = 0): TaskDependency => ({ predecessor_id, successor_id, lag });

type Opts = {
  status?: ISODate;
  target?: ISODate | null;
  priority?: Priority;
  baseline?: Record<number, ISODate>;
  people?: Record<number, number[]>;
  conflicts?: Conflict[];
};

function facts(tasks: Task[], deps: TaskDependency[] = [], o: Opts = {}): PlanFacts {
  const outcome = planProject({ projectStart: MON, tasks, deps, bookings: [] });
  if ('cycle' in outcome) throw new Error('cycle');
  return planFacts({
    project: { id: 1, name: 'Plan', priority: o.priority ?? 'normal', target_date: o.target ?? null },
    projectStart: MON,
    outcome,
    baseline: new Map(Object.entries(o.baseline ?? {}).map(([id, end]) => [Number(id), { start: MON, end }])),
    people: new Map(Object.entries(o.people ?? {}).map(([id, p]) => [Number(id), p])),
    conflicts: o.conflicts ?? [],
    statusDate: o.status ?? MON,
    nearCriticalDays: 2,
  });
}

const run = (f: PlanFacts, long = 20) => assess(f, { long_task_days: long }, new Map([[9, 'Mai']]));
const of = (fs: Finding[], rule: RuleId) => fs.filter((x) => x.rule === rule);

describe('facts', () => {
  it('counts remaining effort and pace from typed progress', () => {
    const f = facts([task(1, 10, { status: 'in_progress', actual_start: MON, progress: 20 })], [], { status: '2026-03-09' });
    const t = f.byId.get(1)!;
    expect(t.remaining).toBe(8);
    expect(t.spi).toBeCloseTo(0.4);
    expect(t.slip).toBe(15);
  });

  it('does not judge pace without a typed figure or before two days have run', () => {
    expect(facts([task(1, 10, { status: 'in_progress', actual_start: MON })], [], { status: '2026-03-09' }).byId.get(1)!.spi).toBeNull();
    expect(facts([task(1, 10, { status: 'in_progress', actual_start: MON, progress: 0 })], [], { status: '2026-03-03' }).byId.get(1)!.spi).toBeNull();
  });

  it('expands links through summaries', () => {
    const f = facts([task(1, 2), task(5, 0), task(2, 3, { parent_id: 5 }), task(3, 3, { parent_id: 5 })], [dep(1, 5)]);
    expect(f.byId.get(2)!.preds).toEqual([1]);
    expect(f.byId.get(1)!.succs).toEqual([2, 3]);
  });
});

describe('progress rules', () => {
  it('P1: finish after target', () => {
    const tasks = [task(1, 5), task(2, 5)];
    const late = of(run(facts(tasks, [dep(1, 2)], { target: '2026-03-11' })), 'P1');
    expect(late).toHaveLength(1);
    expect(late[0].key).toBe('P1:2');
    expect(late[0].text).toContain('2 working days after the target');
    expect(late[0].task_ids).toEqual([1, 2]);
    expect(of(run(facts(tasks, [dep(1, 2)], { target: '2026-03-13' })), 'P1')).toEqual([]);
    expect(of(run(facts(tasks, [dep(1, 2)])), 'P1')).toEqual([]);
  });

  it('P1: a high-priority project scores the same delay higher', () => {
    const tasks = [task(1, 5), task(2, 5)];
    const normal = of(run(facts(tasks, [dep(1, 2)], { target: '2026-03-11' })), 'P1')[0];
    const high = of(run(facts(tasks, [dep(1, 2)], { target: '2026-03-11', priority: 'critical' })), 'P1')[0];
    expect(high.impact).toBe(normal.impact + 1);
  });

  it('P2: negative float when started work runs ahead of its predecessor', () => {
    const f = facts([task(1, 10), task(2, 3, { status: 'in_progress', actual_start: MON })], [dep(1, 2)]);
    const neg = of(run(f), 'P2');
    expect(neg).toHaveLength(1);
    expect(neg[0].task_ids).toEqual([1]);
    expect(of(run(facts([task(1, 10), task(2, 3)], [dep(1, 2)])), 'P2')).toEqual([]);
  });

  it('P3: not started after its scheduled start', () => {
    expect(of(run(facts([task(1, 5)], [], { status: '2026-03-04' })), 'P3').map((x) => x.key)).toEqual(['P3:1']);
    expect(of(run(facts([task(1, 5)], [], { status: MON })), 'P3')).toEqual([]);
    expect(of(run(facts([task(1, 5, { status: 'in_progress', actual_start: MON })], [], { status: '2026-03-04' })), 'P3')).toEqual([]);
  });

  it('P4: running slower than planned', () => {
    const slow = of(run(facts([task(1, 10, { status: 'in_progress', actual_start: MON, progress: 20 })], [], { status: '2026-03-09' })), 'P4');
    expect(slow).toHaveLength(1);
    expect(slow[0].likelihood).toBe(5);
    expect(slow[0].text).toContain('15 working days late');
    expect(of(run(facts([task(1, 10, { status: 'in_progress', actual_start: MON, progress: 60 })], [], { status: '2026-03-09' })), 'P4')).toEqual([]);
  });

  it('P5: blocked on the critical path, not off it', () => {
    const critical = facts([task(1, 3), task(2, 3, { status: 'blocked' })], [dep(1, 2)]);
    expect(of(run(critical), 'P5').map((x) => x.key)).toEqual(['P5:2']);
    const slack = facts([task(1, 30), task(2, 3, { status: 'blocked' })]);
    expect(of(run(slack), 'P5')).toEqual([]);
  });

  it('P6: margin to target halved since the baseline', () => {
    const tasks = [task(1, 5), task(2, 5)];
    const f = facts(tasks, [dep(1, 2)], { target: '2026-03-20', baseline: { 1: MON, 2: '2026-03-04' } });
    expect(of(run(f), 'P6')).toHaveLength(1);
    const kept = facts(tasks, [dep(1, 2)], { target: '2026-03-20', baseline: { 1: MON, 2: '2026-03-13' } });
    expect(of(run(kept), 'P6')).toEqual([]);
  });

  it('P7: tasks due under the baseline are not done', () => {
    const f = facts([task(1, 2), task(2, 2)], [dep(1, 2)], { status: '2026-03-10', baseline: { 1: '2026-03-03', 2: '2026-03-05' } });
    const behind = of(run(f), 'P7');
    expect(behind).toHaveLength(1);
    expect(behind[0].text).toContain('0 of 2 tasks due');
    const done = facts(
      [task(1, 2, { status: 'done', actual_start: MON, actual_end: '2026-03-03' }), task(2, 2, { status: 'done', actual_start: '2026-03-04', actual_end: '2026-03-05' })],
      [dep(1, 2)], { status: '2026-03-10', baseline: { 1: '2026-03-03', 2: '2026-03-05' } },
    );
    expect(of(run(done), 'P7')).toEqual([]);
  });
});

describe('structure rules', () => {
  it('S1: within the near-critical threshold', () => {
    const f = facts([task(1, 2), task(2, 5), task(3, 4), task(4, 1)], [dep(1, 2), dep(1, 3), dep(2, 4), dep(3, 4)]);
    expect(of(run(f), 'S1')[0].task_ids).toEqual([3]);
    const loose = facts([task(1, 2), task(2, 9), task(3, 4), task(4, 1)], [dep(1, 2), dep(1, 3), dep(2, 4), dep(3, 4)]);
    expect(of(run(loose), 'S1')).toEqual([]);
  });

  it('S2: a critical merge point, and its key changes when another path joins', () => {
    const three = facts([task(1, 3), task(2, 3), task(3, 3), task(4, 1)], [dep(1, 4), dep(2, 4), dep(3, 4)]);
    const merge = of(run(three), 'S2');
    expect(merge).toHaveLength(1);
    expect(merge[0].task_ids).toEqual([1, 2, 3, 4]);
    const four = facts([task(1, 3), task(2, 3), task(3, 3), task(5, 3), task(4, 1)], [dep(1, 4), dep(2, 4), dep(3, 4), dep(5, 4)]);
    expect(of(run(four), 'S2')[0].key).not.toBe(merge[0].key);
    const two = facts([task(1, 3), task(2, 3), task(4, 1)], [dep(1, 4), dep(2, 4)]);
    expect(of(run(two), 'S2')).toEqual([]);
  });

  it('S3: thin margin while on time, and quiet once P1 speaks', () => {
    expect(of(run(facts([task(1, 20)], [], { target: '2026-03-27' })), 'S3')).toHaveLength(1);
    expect(of(run(facts([task(1, 20)], [], { target: '2026-04-03' })), 'S3')).toEqual([]);
    expect(of(run(facts([task(1, 20)], [], { target: '2026-03-20' })), 'S3')).toEqual([]);
  });

  it('S4: an open clash on an environment critical work needs', () => {
    const clash: Conflict = {
      environment_id: 7, env_name: 'SIT', env_kind: 'SIT', capacity: 1, start_date: '2026-03-03', end_date: '2026-03-04',
      peak: 2, booking_ids: [11, 12], projects: [{ id: 1, name: 'Plan', priority: 'normal' }, { id: 2, name: 'Other', priority: 'high' }],
      overlap_days: 2, severity: 6,
    };
    const tasks = [task(1, 5, { environment_id: 7 })];
    const hit = of(run(facts(tasks, [], { conflicts: [clash] })), 'S4');
    expect(hit).toHaveLength(1);
    expect(hit[0].key).toBe('S4:7:11:12');
    expect(hit[0].text).toContain('with Other');
    expect(of(run(facts(tasks, [], { conflicts: [{ ...clash, resolved: true }] })), 'S4')).toEqual([]);
    expect(of(run(facts(tasks, [], { conflicts: [{ ...clash, projects: clash.projects.slice(1) }] })), 'S4')).toEqual([]);
  });

  it('S5: one person on parallel critical tasks', () => {
    const f = facts([task(1, 3), task(2, 3)], [], { people: { 1: [9], 2: [9] } });
    const s5 = of(run(f), 'S5');
    expect(s5).toHaveLength(1);
    expect(s5[0].text).toMatch(/^Mai is on/);
    expect(of(run(facts([task(1, 3), task(2, 3)], [dep(1, 2)], { people: { 1: [9], 2: [9] } })), 'S5')).toEqual([]);
  });

  it('S6: unassigned critical work, only in plans that name people', () => {
    const tasks = [task(1, 3), task(2, 1)];
    expect(of(run(facts(tasks, [], { people: { 2: [9] } })), 'S6')[0].task_ids).toEqual([1]);
    expect(of(run(facts(tasks)), 'S6')).toEqual([]);
  });
});

describe('hygiene rules', () => {
  it('H1: a task that feeds nothing', () => {
    const f = facts([task(1, 5), task(2, 5), task(3, 2)], [dep(1, 2)]);
    const h1 = of(run(f), 'H1');
    expect(h1[0].task_ids).toEqual([3]);
    expect(h1[0].text).toContain('feeds nothing');
    expect(of(run(facts([task(1, 5), task(2, 5), task(3, 2)], [dep(1, 2), dep(3, 2)])), 'H1')).toEqual([]);
  });

  it('H2 and H3: leads, and lags longer than the work', () => {
    expect(of(run(facts([task(1, 5), task(2, 5)], [dep(1, 2, -1)])), 'H2')).toHaveLength(1);
    expect(of(run(facts([task(1, 5), task(2, 2)], [dep(1, 2, 5)])), 'H3')).toHaveLength(1);
    expect(of(run(facts([task(1, 5), task(2, 5)], [dep(1, 2, 1)])), 'H3')).toEqual([]);
  });

  it('H4: a date holding a task later than its links', () => {
    const held = facts([task(1, 2), task(2, 2, { not_before: '2026-03-16' })], [dep(1, 2)]);
    expect(of(run(held), 'H4').map((x) => x.task_ids)).toEqual([[2]]);
    const idle = facts([task(1, 5), task(2, 2, { not_before: '2026-03-03' })], [dep(1, 2)]);
    expect(of(run(idle), 'H4')).toEqual([]);
  });

  it('H5: longer than the setting', () => {
    expect(of(run(facts([task(1, 25)])), 'H5')).toHaveLength(1);
    expect(of(run(facts([task(1, 25)]), 44), 'H5')).toEqual([]);
  });

  it('H6: float high enough to suggest a missing link', () => {
    expect(of(run(facts([task(1, 60), task(2, 5)])), 'H6')[0].task_ids).toEqual([2]);
  });
});

describe('assess', () => {
  it('ranks by severity, and every finding is on the 1–5 scales', () => {
    const f = facts(
      [task(1, 5), task(2, 5, { status: 'blocked' }), task(3, 25)],
      [dep(1, 2)],
      { target: '2026-03-06', status: '2026-03-04' },
    );
    const all = run(f);
    expect(all.length).toBeGreaterThan(2);
    for (let i = 1; i < all.length; i++) expect(all[i - 1].severity).toBeGreaterThanOrEqual(all[i].severity);
    for (const x of all) {
      expect(x.severity).toBe(x.likelihood * x.impact);
      expect(x.likelihood).toBeGreaterThanOrEqual(1);
      expect(x.impact).toBeLessThanOrEqual(5);
    }
    expect(new Set(all.map((x) => x.key)).size).toBe(all.length);
  });

  it('says nothing about a finished plan', () => {
    const done = { status: 'done' as const, actual_start: MON, actual_end: '2026-03-03' };
    expect(run(facts([task(1, 2, done)], [], { status: '2026-03-20' }))).toEqual([]);
  });
});
