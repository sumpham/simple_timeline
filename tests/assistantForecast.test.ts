import { describe, expect, it } from 'vitest';
import { forecast, triangular, type ForecastInput } from '../shared/assistant/forecast.ts';
import { seededRandom } from '../shared/assistant/random.ts';
import { estimateError, rangeOf } from '../shared/estimates.ts';
import { scheduleProject } from '../shared/schedule.ts';
import type { Task, TaskDependency } from '../shared/types.ts';

// 2026-03-02 is a Monday.
const MON = '2026-03-02';

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name: `T${id}`, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}
const dep = (predecessor_id: number, successor_id: number, lag = 0): TaskDependency => ({ predecessor_id, successor_id, lag });
const exact = (id: number, d: number, p: Partial<Task> = {}) => task(id, d, { duration_low: d, duration_high: d, ...p });

function run(input: Partial<ForecastInput> & Pick<ForecastInput, 'tasks'>) {
  const f = forecast({ deps: [], projectStart: MON, statusDate: MON, runs: 500, ...input });
  if (!f) throw new Error('no forecast');
  return f;
}

describe('estimates', () => {
  it('checks best and worst against the duration', () => {
    expect(estimateError(10, 8, 15)).toBeNull();
    expect(estimateError(10, null, null)).toBeNull();
    expect(estimateError(10, 12, null)).toMatch(/Best case/);
    expect(estimateError(10, null, 9)).toMatch(/Worst case/);
    expect(estimateError(10, -1, null)).toMatch(/whole number/);
  });

  it('defaults to a right-skewed range and stretches to hold a changed duration', () => {
    expect(rangeOf({ duration: 10 })).toEqual({ low: 9, mode: 10, high: 13, typed: false });
    expect(rangeOf({ duration: 20, duration_low: 8, duration_high: 15 })).toEqual({ low: 8, mode: 20, high: 20, typed: true });
  });
});

describe('triangular', () => {
  it('stays inside its range and centres on the mean', () => {
    const r = seededRandom(3);
    const xs = Array.from({ length: 20000 }, () => triangular(r, 2, 4, 12));
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(2);
    expect(Math.max(...xs)).toBeLessThanOrEqual(12);
    expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(6, 1);
  });
});

describe('forecast', () => {
  it('is the CPM finish when every range has zero width', () => {
    const tasks = [exact(1, 5), exact(2, 3), exact(3, 4), exact(4, 0)];
    const deps = [dep(1, 2), dep(1, 3), dep(2, 4), dep(3, 4)];
    const cpm = scheduleProject({ tasks, deps, projectStart: MON });
    if ('cycle' in cpm) throw new Error();
    const f = run({ tasks, deps });
    expect(f.planned).toBe(cpm.finish);
    expect(f.p50).toBe(cpm.finish);
    expect(f.p80).toBe(cpm.finish);
    expect(f.p90).toBe(cpm.finish);
    expect(f.sensitivity).toEqual([]);
  });

  it('gives each deadline its own P80 and chance, the CPM finish at zero width', () => {
    // T1 Mon–Fri 6 Mar, T2 after it Mon–Wed 11 Mar.
    const tasks = [exact(1, 5, { deadline: '2026-03-06' }), exact(2, 3, { deadline: '2026-03-10' })];
    const f = run({ tasks, deps: [dep(1, 2)] });
    expect(f.deadlines).toEqual([
      { id: 1, deadline: '2026-03-06', p80: '2026-03-06', on_time: 1 },
      { id: 2, deadline: '2026-03-10', p80: '2026-03-11', on_time: 0 },
    ]);
  });

  it('leaves the finish alone when deadlines are added', () => {
    const plain = run({ tasks: [task(1, 5), task(2, 8)], deps: [dep(1, 2)] });
    const held = run({ tasks: [task(1, 5, { deadline: '2026-03-03' }), task(2, 8)], deps: [dep(1, 2)] });
    expect({ ...held, deadlines: [] }).toEqual(plain);
    expect(held.deadlines[0].on_time).toBe(0);
  });

  it('gives the same answer for the same plan and date, run after run', () => {
    const tasks = [task(1, 5), task(2, 8), task(3, 3)];
    const deps = [dep(1, 3), dep(2, 3)];
    expect(run({ tasks, deps })).toEqual(run({ tasks, deps }));
  });

  it('is later at P80 than P50, and later still when a critical worst case widens', () => {
    const tasks = [task(1, 10), task(2, 10)];
    const deps = [dep(1, 2)];
    const f = run({ tasks, deps });
    expect(f.p80 >= f.p50).toBe(true);
    const wide = run({ tasks: [task(1, 10, { duration_high: 30 }), task(2, 10)], deps });
    expect(wide.p80 > f.p80).toBe(true);
  });

  it('reports the chance of meeting a target', () => {
    const tasks = [task(1, 10)];
    expect(run({ tasks, target: '2026-12-31' }).on_time).toBe(1);
    expect(run({ tasks, target: '2026-03-03' }).on_time).toBe(0);
    const mid = run({ tasks: [task(1, 10, { duration_low: 5, duration_high: 15 })], target: '2026-03-13' }).on_time!;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
    expect(run({ tasks }).on_time).toBeNull();
  });

  it('finds the task that often becomes critical, which CPM alone calls safe', () => {
    // Task 2 has 1 day of float but a long tail; it drives the finish in many runs.
    const tasks = [exact(1, 10), task(2, 9, { duration_low: 9, duration_high: 20 }), exact(3, 1)];
    const deps = [dep(1, 3), dep(2, 3)];
    const cpm = scheduleProject({ tasks, deps, projectStart: MON });
    if ('cycle' in cpm) throw new Error();
    expect(cpm.tasks.get(2)!.critical).toBe(false);
    const f = run({ tasks, deps });
    const two = f.criticality.find((c) => c.id === 2)!;
    expect(two.index).toBeGreaterThan(0.6);
    expect(f.sensitivity[0].id).toBe(2);
  });

  it('floors unfinished work at the status date', () => {
    const tasks = [exact(1, 5)];
    const late = run({ tasks, statusDate: '2026-03-16' });
    expect(late.planned).toBe('2026-03-06');
    expect(late.deterministic).toBe('2026-03-20');
    expect(late.p50).toBe('2026-03-20');
  });

  it('runs a started task’s remaining work from the status date, slower when it is slow', () => {
    const started = task(1, 10, { status: 'in_progress', actual_start: MON, progress: 20 });
    const f = run({ tasks: [started], statusDate: '2026-03-09' });
    // Eight days left from Monday 9 March: Wednesday 18 March.
    expect(f.deterministic).toBe('2026-03-18');
    const slow = run({ tasks: [started], statusDate: '2026-03-09', pace: new Map([[1, 0.4]]) });
    expect(slow.p80 > f.p80).toBe(true);
  });

  it('keeps done work where it happened', () => {
    const tasks = [task(1, 3, { status: 'done', actual_start: MON, actual_end: '2026-03-04' }), exact(2, 2)];
    const f = run({ tasks, deps: [dep(1, 2)], statusDate: MON });
    expect(f.p50).toBe('2026-03-06');
    expect(f.criticality.map((c) => c.id)).toEqual([2]);
  });

  it('counts tasks on default ranges, and the critical ones among them', () => {
    const f = forecast({ tasks: [task(1, 5), exact(2, 3), task(3, 1)], deps: [dep(1, 3)], projectStart: MON, statusDate: MON, runs: 100 }, new Set([1, 3]))!;
    expect(f.estimated).toBe(1);
    expect(f.defaulted).toBe(2);
    expect(f.defaulted_critical).toEqual([1, 3]);
  });

  it('caps its runs and has nothing to say about an empty plan', () => {
    expect(run({ tasks: [task(1, 2)], runs: 1e9 }).runs).toBe(10000);
    expect(forecast({ tasks: [], deps: [], projectStart: MON, statusDate: MON, runs: 100 })).toBeNull();
  });

  it('forecasts a 300-task plan at 1,000 runs within its budget', () => {
    const tasks: Task[] = [];
    const deps: TaskDependency[] = [];
    const r = seededRandom(11);
    for (let i = 1; i <= 300; i++) {
      tasks.push(task(i, 1 + Math.floor(r() * 10)));
      if (i > 5) for (let k = 0; k < 2; k++) deps.push(dep(1 + Math.floor(r() * (i - 1)), i));
    }
    const unique = [...new Map(deps.map((d) => [`${d.predecessor_id}>${d.successor_id}`, d])).values()];
    const t0 = performance.now();
    const f = run({ tasks, deps: unique, runs: 1000 });
    const ms = performance.now() - t0;
    expect(f.p80 >= f.p50).toBe(true);
    expect(ms).toBeLessThan(1500);
  });
});
