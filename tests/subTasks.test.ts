import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scheduleProject, type ScheduleResult } from '../shared/schedule.ts';
import { planProject } from '../shared/plan.ts';
import { inheritedFloors, rolledUp } from '../shared/wbs.ts';
import type { Project, Task, TaskDependency } from '../shared/types.ts';

/**
 * Sub-tasks to the WBS standard (reqs/sub_tasks.md): a summary has no work of its
 * own, its status and actuals roll up, its constraint holds its tasks, and the
 * write path keeps those rules when the outline changes.
 */

// 2026-03-02 is a Monday.
const MON = '2026-03-02';

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name: `T${id}`, duration, status: 'todo', not_before: null,
    assignee: null, note: null, sort_order: id, actual_start: null, actual_end: null,
    start_date: null, end_date: null, total_float: null, critical: 0, parent_id: null, progress: null, code: id, ...partial,
  };
}
const dep = (predecessor_id: number, successor_id: number, type: TaskDependency['type'] = 'FS'): TaskDependency =>
  ({ predecessor_id, successor_id, lag: 0, type });

function ok(r: ReturnType<typeof scheduleProject>): ScheduleResult {
  if ('cycle' in r) throw new Error(`unexpected cycle ${r.cycle}`);
  return r;
}

describe('rolledUp', () => {
  const s = (status: Task['status'], actual_start: string | null = null, actual_end: string | null = null) =>
    ({ status, actual_start, actual_end });

  it('is done only when every task is, with the last actual finish', () => {
    expect(rolledUp([s('done', '2026-03-02', '2026-03-04'), s('done', '2026-03-03', '2026-03-06')]))
      .toEqual({ status: 'done', actual_start: '2026-03-02', actual_end: '2026-03-06' });
    expect(rolledUp([s('done', '2026-03-02', '2026-03-04'), s('todo')]))
      .toEqual({ status: 'in_progress', actual_start: '2026-03-02', actual_end: null });
  });

  it('reads in progress over blocked once work has started, blocked over to do', () => {
    expect(rolledUp([s('blocked'), s('in_progress', '2026-03-05')]).status).toBe('in_progress');
    expect(rolledUp([s('blocked'), s('todo')])).toEqual({ status: 'blocked', actual_start: null, actual_end: null });
    expect(rolledUp([s('todo'), s('todo')]).status).toBe('todo');
  });
});

describe('a summary’s start no earlier than', () => {
  it('holds every task under it, at any depth, and a later own floor still wins', () => {
    const tasks = [
      task(10, 0, { not_before: '2026-03-09' }),
      task(11, 0, { parent_id: 10 }),
      task(1, 2, { parent_id: 11 }),
      task(2, 2, { parent_id: 10, not_before: '2026-03-16' }),
      task(3, 1),
    ];
    expect(inheritedFloors(tasks).get(1)).toBe('2026-03-09');
    const r = ok(scheduleProject({ tasks, deps: [], projectStart: MON }));
    expect(r.tasks.get(1)!.start).toBe('2026-03-09');
    expect(r.tasks.get(2)!.start).toBe('2026-03-16');
    expect(r.tasks.get(3)!.start).toBe(MON);
    expect(r.tasks.get(10)).toMatchObject({ start: '2026-03-09', end: '2026-03-17', summary: true });
  });
});

describe('planProject on summaries', () => {
  it('stamps the rolled-up status and actuals over whatever the summary stored', () => {
    const tasks = [
      task(10, 5, { status: 'todo' }),
      task(1, 2, { parent_id: 10, status: 'done', actual_start: MON, actual_end: '2026-03-03' }),
      task(2, 2, { parent_id: 10, status: 'in_progress', actual_start: '2026-03-04' }),
    ];
    const out = planProject({ projectStart: MON, tasks, deps: [dep(1, 2)], bookings: [] });
    if ('cycle' in out) throw new Error('cycle');
    expect(out.tasks.find((t) => t.id === 10)).toMatchObject({ status: 'in_progress', actual_start: MON, actual_end: null });
    expect(out.tasks.find((t) => t.id === 2)).toMatchObject({ status: 'in_progress' });
  });
});

// ---------------------------------------------------------------- the write path

describe('applyChange with sub-tasks', () => {
  let dir: string;
  let plan: typeof import('../server/plan.ts');
  const project = { id: 1, team_id: 1, name: 'P', start_date: MON } as Project;
  const state = (tasks: Task[], deps: TaskDependency[] = []) => ({ project, tasks, deps, bookings: [] });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'timeline-subtasks-'));
    process.env.TIMELINE_DB = join(dir, 'test.db');
    plan = await import('../server/plan.ts');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('gives the first sub-task its parent’s environment, so the booking moves down', () => {
    const next = plan.applyChange(state([task(1, 5, { environment_id: 7 })]), { op: 'create', fields: { name: 'Sub', parent_id: 1 } });
    expect(next.tasks.find((t) => t.id === plan.NEW_TASK_ID)).toMatchObject({ parent_id: 1, environment_id: 7 });
    expect(next.tasks.find((t) => t.id === 1)!.environment_id).toBeNull();
  });

  it('keeps an environment the sub-task was given, and later sub-tasks do not inherit', () => {
    const own = plan.applyChange(state([task(1, 5, { environment_id: 7 })]), { op: 'create', fields: { name: 'Sub', parent_id: 1, environment_id: 8 } });
    expect(own.tasks.find((t) => t.id === plan.NEW_TASK_ID)!.environment_id).toBe(8);
    const second = plan.applyChange(state([task(1, 0), task(2, 3, { parent_id: 1, environment_id: 7 })]), { op: 'create', fields: { name: 'Sub', parent_id: 1 } });
    expect(second.tasks.find((t) => t.id === plan.NEW_TASK_ID)!.environment_id).toBeNull();
  });

  it('passes the environment down on an indent too', () => {
    const next = plan.applyChange(state([task(1, 5, { environment_id: 7 }), task(2, 3)]),
      { op: 'outline', placements: [{ id: 2, parent_id: 1, sort_order: 0 }] });
    expect(next.tasks.find((t) => t.id === 2)!.environment_id).toBe(7);
    expect(next.tasks.find((t) => t.id === 1)!.environment_id).toBeNull();
  });

  it('refuses fields a summary does not have, and allows the ones it does', () => {
    const s = state([task(1, 0), task(2, 3, { parent_id: 1 })]);
    expect(() => plan.applyChange(s, { op: 'update', id: 1, fields: { status: 'done' } })).toThrow(/status comes from/);
    expect(() => plan.applyChange(s, { op: 'update', id: 1, fields: { duration: 4 } })).toThrow(/length comes from/);
    expect(() => plan.applyChange(s, { op: 'update', id: 1, fields: { environment_id: 7 } })).toThrow(/books nothing/);
    expect(() => plan.applyChange(s, { op: 'update', id: 1, fields: { progress: 50 } })).toThrow(/progress comes from/);
    const next = plan.applyChange(s, { op: 'update', id: 1, fields: { name: 'Build', not_before: '2026-03-09', assignee: 'Kim', status: 'todo' } });
    expect(next.tasks.find((t) => t.id === 1)).toMatchObject({ name: 'Build', not_before: '2026-03-09', assignee: 'Kim' });
  });

  it('turns a summary back into a task with the length it showed', () => {
    // Stored as replan leaves it: the summary's dates span its task, Mon to Wed next week.
    const s = state([task(1, 99, { start_date: MON, end_date: '2026-03-11' }), task(2, 8, { parent_id: 1 })]);
    const next = plan.applyChange(s, { op: 'outline', placements: [{ id: 2, parent_id: null, sort_order: 5 }] });
    expect(next.tasks.find((t) => t.id === 1)!.duration).toBe(8);
  });

  it('deletes a summary with its branch, or lifts its tasks a level', () => {
    const tasks = [task(1, 0), task(2, 2, { parent_id: 1 }), task(3, 2, { parent_id: 1 }), task(4, 1)];
    const deps = [dep(2, 3), dep(3, 4)];
    const gone = plan.applyChange(state(tasks, deps), { op: 'delete', id: 1, children: 'delete' });
    expect(gone.tasks.map((t) => t.id)).toEqual([4]);
    expect(gone.deps).toEqual([]);
    const lifted = plan.applyChange(state(tasks, deps), { op: 'delete', id: 1 });
    expect(lifted.tasks.map((t) => [t.id, t.parent_id])).toEqual([[2, null], [3, null], [4, null]]);
    expect(lifted.deps).toHaveLength(2);
  });

  it('keeps the chain across a deleted branch when asked', () => {
    const tasks = [task(5, 1), task(1, 0), task(2, 2, { parent_id: 1 }), task(3, 2, { parent_id: 1 }), task(4, 1)];
    const next = plan.applyChange(state(tasks, [dep(5, 2), dep(2, 3), dep(3, 4)]), { op: 'delete', id: 1, children: 'delete', bridge: true });
    expect(next.deps).toEqual([{ predecessor_id: 5, successor_id: 4, lag: 0, type: 'FS' }]);
  });

  it('names the link that stops a task becoming a summary', () => {
    const s = state([task(1, 3), task(2, 3), task(3, 1)], [dep(3, 1, 'SS')]);
    expect(() => plan.applyChange(s, { op: 'outline', placements: [{ id: 2, parent_id: 1, sort_order: 0 }] }))
      .toThrow('T1 would be a summary, and links to or from a summary are finish-to-start only: T3 → T1 is SS. Make that link FS first');
  });
});
