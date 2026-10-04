import { describe, expect, it } from 'vitest';
import {
  cycleWith, forwardPass, indexNetwork, lateBy, scheduleProject, type IndexNetwork, type ScheduleResult,
} from '../shared/schedule.ts';
import { addDays } from '../shared/dates.ts';
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

function ok(r: ReturnType<typeof scheduleProject>): ScheduleResult {
  if ('cycle' in r) throw new Error(`unexpected cycle ${r.cycle}`);
  return r;
}

describe('scheduleProject', () => {
  it('chains finish-to-start across a weekend', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 5), task(2, 3)], deps: [dep(1, 2)], projectStart: MON }));
    expect(r.tasks.get(1)).toMatchObject({ start: '2026-03-02', end: '2026-03-06' });
    expect(r.tasks.get(2)).toMatchObject({ start: '2026-03-09', end: '2026-03-11' });
    expect(r.finish).toBe('2026-03-11');
    expect(r.critical_path).toEqual([1, 2]);
  });

  it('skips holidays in durations', () => {
    const holidays = new Set(['2026-03-04']);
    const r = ok(scheduleProject({ tasks: [task(1, 3)], deps: [], projectStart: MON, holidays }));
    expect(r.tasks.get(1)).toMatchObject({ start: '2026-03-02', end: '2026-03-05' });
  });

  it('snaps a weekend project start onto Monday', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 1)], deps: [], projectStart: '2026-02-28' }));
    expect(r.tasks.get(1)!.start).toBe(MON);
  });

  it('applies lag and lead', () => {
    const lag = ok(scheduleProject({ tasks: [task(1, 2), task(2, 1)], deps: [dep(1, 2, 2)], projectStart: MON }));
    expect(lag.tasks.get(2)!.start).toBe('2026-03-06');
    const lead = ok(scheduleProject({ tasks: [task(1, 4), task(2, 1)], deps: [dep(1, 2, -2)], projectStart: MON }));
    expect(lead.tasks.get(2)!.start).toBe('2026-03-04');
  });

  it('gives parallel paths float, and only the longest is critical', () => {
    const r = ok(scheduleProject({
      tasks: [task(1, 2), task(2, 5), task(3, 2), task(4, 1)],
      deps: [dep(1, 2), dep(1, 3), dep(2, 4), dep(3, 4)],
      projectStart: MON,
    }));
    expect(r.tasks.get(3)!.total_float).toBe(3);
    expect(r.tasks.get(3)!.free_float).toBe(3);
    expect(r.tasks.get(3)!.critical).toBe(false);
    expect(r.critical_path).toEqual([1, 2, 4]);
  });

  it('respects start no earlier than', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 2, { not_before: '2026-03-10' })], deps: [], projectStart: MON }));
    expect(r.tasks.get(1)).toMatchObject({ start: '2026-03-10', end: '2026-03-11' });
  });

  it('puts a finish milestone on its predecessor’s last day', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 5), task(2, 0), task(3, 1)], deps: [dep(1, 2), dep(2, 3)], projectStart: MON }));
    expect(r.tasks.get(2)).toMatchObject({ start: '2026-03-06', end: '2026-03-06' });
    expect(r.tasks.get(3)!.start).toBe('2026-03-09');
  });

  it('keeps done and started tasks on their actual dates', () => {
    const r = ok(scheduleProject({
      tasks: [
        task(1, 5, { status: 'done', actual_start: MON, actual_end: '2026-03-03' }),
        task(2, 3, { status: 'in_progress', actual_start: '2026-03-05' }),
        task(3, 1),
      ],
      deps: [dep(1, 2), dep(2, 3)],
      projectStart: MON,
    }));
    expect(r.tasks.get(1)).toMatchObject({ start: MON, end: '2026-03-03', critical: false });
    expect(r.tasks.get(2)).toMatchObject({ start: '2026-03-05', end: '2026-03-09' });
    expect(r.tasks.get(3)!.start).toBe('2026-03-10');
  });

  it('reports a cycle instead of scheduling', () => {
    const r = scheduleProject({ tasks: [task(1, 1), task(2, 1), task(3, 1)], deps: [dep(1, 2), dep(2, 3), dep(3, 2)], projectStart: MON });
    expect('cycle' in r && r.cycle).toEqual(expect.arrayContaining([2, 3]));
  });

  it('terminates and stays ordered for every start day of a year', () => {
    // Bounded-loop rule: sweep starts, including weekends, never just one.
    for (let i = 0; i < 366; i++) {
      const start = addDays('2026-01-01', i);
      const r = ok(scheduleProject({ tasks: [task(1, 3), task(2, 0), task(3, 4)], deps: [dep(1, 2), dep(2, 3)], projectStart: start }));
      expect(r.tasks.get(3)!.start > r.tasks.get(1)!.end).toBe(true);
    }
  });

  it('handles an empty plan', () => {
    const r = ok(scheduleProject({ tasks: [], deps: [], projectStart: MON }));
    expect(r.finish).toBe(MON);
    expect(r.critical_path).toEqual([]);
  });
});

describe('cycleWith', () => {
  it('names the loop a new link would close', () => {
    expect(cycleWith([dep(1, 2), dep(2, 3)], 3, 1)).toEqual([1, 2, 3, 1]);
    expect(cycleWith([dep(1, 2)], 1, 3)).toBeNull();
    expect(cycleWith([], 4, 4)).toEqual([4, 4]);
  });
});

describe('lateBy', () => {
  it('counts working days past the target', () => {
    expect(lateBy('2026-03-09', '2026-03-06')).toBe(1);
    expect(lateBy('2026-03-06', '2026-03-09')).toBe(0);
    expect(lateBy('2026-03-06', null)).toBe(0);
  });
});

describe('link types', () => {
  const typed = (p: number, s: number, type: 'SS' | 'FF', lag = 0): TaskDependency => ({ predecessor_id: p, successor_id: s, lag, type });

  it('starts an SS successor with its predecessor, plus lag', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 5), task(2, 2)], deps: [typed(1, 2, 'SS', 1)], projectStart: MON }));
    expect(r.tasks.get(2)).toMatchObject({ start: '2026-03-03', end: '2026-03-04' });
    // Task 2 can slip until it would finish past task 1: three working days.
    expect(r.tasks.get(2)!.total_float).toBe(2);
    expect(r.tasks.get(1)!.critical).toBe(true);
  });

  it('finishes an FF successor no earlier than its predecessor', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 5), task(2, 2)], deps: [typed(1, 2, 'FF')], projectStart: MON }));
    expect(r.tasks.get(2)).toMatchObject({ start: '2026-03-05', end: '2026-03-06' });
    expect(r.tasks.get(2)!.critical).toBe(true);
  });

  it('reads a link without a type as finish-to-start', () => {
    const r = ok(scheduleProject({ tasks: [task(1, 2), task(2, 1)], deps: [{ predecessor_id: 1, successor_id: 2, lag: 0, type: null }], projectStart: MON }));
    expect(r.tasks.get(2)!.start).toBe('2026-03-04');
  });
});

describe('summary tasks', () => {
  // 10 is a summary over 1 and 2; 3 comes after the summary.
  const tasks = [task(10, 99), task(1, 2, { parent_id: 10 }), task(2, 3, { parent_id: 10 }), task(3, 1)];

  it('rolls dates, float and criticality up from the tasks under it', () => {
    const r = ok(scheduleProject({ tasks, deps: [dep(1, 2), dep(10, 3)], projectStart: MON }));
    expect(r.tasks.get(10)).toMatchObject({ start: '2026-03-02', end: '2026-03-06', summary: true, critical: true });
    expect(r.tasks.get(3)!.start).toBe('2026-03-09');
    expect(r.finish).toBe('2026-03-09');
    expect(r.critical_path).toEqual([1, 2, 3]);
  });

  it('holds every task under a summary a link points at', () => {
    const r = ok(scheduleProject({ tasks: [...tasks], deps: [dep(3, 10)], projectStart: MON }));
    expect(r.tasks.get(1)!.start).toBe('2026-03-03');
    expect(r.tasks.get(2)!.start).toBe('2026-03-03');
    expect(r.tasks.get(10)!.start).toBe('2026-03-03');
  });

  it('ignores the summary’s own duration', () => {
    const r = ok(scheduleProject({ tasks, deps: [], projectStart: MON }));
    expect(r.tasks.get(10)!.end).toBe('2026-03-04');
  });
});

describe('indexNetwork and forwardPass', () => {
  function net(r: ReturnType<typeof indexNetwork>): IndexNetwork {
    if ('cycle' in r) throw new Error(`unexpected cycle ${r.cycle}`);
    return r;
  }

  it('agrees with scheduleProject on planned durations', () => {
    const input = {
      tasks: [
        task(1, 3, { status: 'done', actual_start: MON, actual_end: '2026-03-05' }),
        task(2, 4, { status: 'in_progress', actual_start: '2026-03-04' }),
        task(3, 2, { not_before: '2026-03-16' }),
        task(4, 0),
        task(5, 5),
      ],
      deps: [dep(1, 3), dep(2, 4), dep(3, 4), { ...dep(2, 5, 1), type: 'SS' as const }],
      projectStart: MON,
    };
    const r = ok(scheduleProject(input));
    const n = net(indexNetwork(input));
    const f = forwardPass(n);
    n.ids.forEach((id, i) => {
      const s = r.tasks.get(id)!;
      if (f.ef[i] > f.es[i]) {
        expect(n.dateOf(f.es[i])).toBe(s.start);
        expect(n.dateOf(f.ef[i] - 1)).toBe(s.end);
      } else {
        expect(n.dateOf(f.es[i] - 1)).toBe(s.start);
      }
    });
    expect(n.dateOf(f.finish - 1)).toBe(r.finish);
  });

  it('lists positions in dependency order and leaves summaries out', () => {
    const n = net(indexNetwork({
      tasks: [task(9, 0), task(1, 2, { parent_id: 9 }), task(2, 3, { parent_id: 9 }), task(3, 1)],
      deps: [dep(9, 3), dep(2, 1)],
      projectStart: MON,
    }));
    expect(n.ids).toEqual([2, 1, 3]);
    expect(n.preds[2].map((p) => n.ids[p.from]).sort()).toEqual([1, 2]);
  });

  it('runs again with other durations, keeping done work fixed', () => {
    const n = net(indexNetwork({
      tasks: [task(1, 2, { status: 'done', actual_start: MON, actual_end: '2026-03-03' }), task(2, 3), task(3, 4)],
      deps: [dep(1, 2), dep(2, 3)],
      projectStart: MON,
    }));
    expect(forwardPass(n).finish).toBe(9);
    const longer = forwardPass(n, [10, 5, 4]);
    expect(longer.es[0]).toBe(0);
    expect(longer.ef[0]).toBe(2);
    expect(longer.finish).toBe(11);
  });

  it('reports a loop instead of a network', () => {
    expect(indexNetwork({ tasks: [task(1, 1), task(2, 1)], deps: [dep(1, 2), dep(2, 1)], projectStart: MON }))
      .toHaveProperty('cycle');
  });
});

describe('deadlines', () => {
  // T1 (5d) and T2 (3d) in parallel; T1 sets the finish, Fri 6 Mar.
  const plan = (t2: Partial<Task> = {}, t1: Partial<Task> = {}) => ok(scheduleProject({
    tasks: [task(1, 5, t1), task(2, 3, t2)], deps: [], projectStart: MON,
  }));

  it('never moves a task, however tight', () => {
    const r = plan({ deadline: '2026-03-03' });
    expect(r.tasks.get(2)).toMatchObject({ start: '2026-03-02', end: '2026-03-04' });
    expect(r.finish).toBe('2026-03-06');
  });

  it('eats float: a task finishing on its deadline has none and is critical', () => {
    expect(plan().tasks.get(2)).toMatchObject({ total_float: 2, critical: false });
    const r = plan({ deadline: '2026-03-04' });
    expect(r.tasks.get(2)).toMatchObject({ total_float: 0, critical: true, deadline_slack: 0, deadline: '2026-03-04' });
    expect(r.critical_path).toEqual([2, 1]);
  });

  it('gives negative float past the deadline, in working days', () => {
    // Finishes Fri 6 Mar; due Wed 4 Mar.
    const r = plan({}, { deadline: '2026-03-04' });
    expect(r.tasks.get(1)).toMatchObject({ total_float: -2, deadline_slack: -2, critical: true });
  });

  it('reads a weekend deadline as the Friday before', () => {
    const r = plan({}, { deadline: '2026-03-08' });
    expect(r.tasks.get(1)).toMatchObject({ total_float: 0, deadline_slack: 0 });
  });

  it('only tightens: a deadline after the finish leaves float alone but reports its slack', () => {
    const r = plan({ deadline: '2026-03-20' });
    expect(r.tasks.get(2)).toMatchObject({ total_float: 2, deadline_slack: 12 });
  });

  it('pulls float out of the predecessors too', () => {
    const r = ok(scheduleProject({
      tasks: [task(1, 2), task(2, 2, { deadline: '2026-03-04' }), task(3, 6)], deps: [dep(1, 2)], projectStart: MON,
    }));
    // T1 Mon–Tue, T2 Wed–Thu, due Wed: one day short along the whole chain.
    expect(r.tasks.get(1)!.total_float).toBe(-1);
    expect(r.tasks.get(2)!.total_float).toBe(-1);
  });

  it('holds every task under a summary, and rolls the tightest one up', () => {
    const r = ok(scheduleProject({
      tasks: [task(10, 0, { deadline: '2026-03-05' }), task(1, 5, { parent_id: 10 }), task(2, 2, { parent_id: 10, deadline: '2026-03-03' })],
      deps: [], projectStart: MON,
    }));
    expect(r.tasks.get(1)).toMatchObject({ deadline: '2026-03-05', deadline_slack: -1 });
    // Its own deadline is earlier than the summary's, so its own counts.
    expect(r.tasks.get(2)).toMatchObject({ deadline: '2026-03-03', deadline_slack: 0 });
    expect(r.tasks.get(10)).toMatchObject({ summary: true, deadline: '2026-03-03', deadline_slack: -1 });
  });

  it('is absent with no deadline', () => {
    expect('deadline_slack' in plan().tasks.get(1)!).toBe(false);
  });
});
