/**
 * The one write path for a project's plan.
 *
 * Every change to tasks, dependencies, a project's start, a booking's manual
 * dates or the holiday table ends in `replan`: schedule the tasks, work out the
 * holds, and bring the project's bookings into line (shared/plan.ts). The
 * preview endpoint runs the same pure functions without writing, so what the
 * impact panel predicts is what the save does.
 */
import { all, audit, get, run } from './db.ts';
import { holidaySet, listBookings, listEnvironments } from './queries.ts';
import { planImpact, planProject, type PlanOutcome } from '../shared/plan.ts';
import { autoBookingKind, type ReconcileBooking } from '../shared/taskHolds.ts';
import { defaultProjectStart } from '../shared/schedule.ts';
import { effectiveKind } from '../shared/bookings.ts';
import { today } from '../shared/dates.ts';
import type {
  Booking, Environment, ISODate, PlanImpact, Project, Task, TaskDependency, TaskStatus,
} from '../shared/types.ts';

export class PlanError extends Error {}

export type PlanState = {
  project: Project;
  tasks: Task[];
  deps: TaskDependency[];
  bookings: ReconcileBooking[];
};

/** Bookings the plan may reshape: auto ones, and manual spans. Releases and one-day events are moments. */
function managed(b: Booking): boolean {
  if (b.manual_start == null || b.manual_end == null) return true;
  return b.kind !== 'RELEASE' && b.manual_start !== b.manual_end;
}

export function loadState(projectId: number): PlanState {
  const project = get<Project>('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new PlanError('Project not found');
  const tasks = all<Task>('SELECT * FROM task WHERE project_id = ? ORDER BY sort_order, id', projectId);
  const deps = all<TaskDependency>(
    `SELECT d.* FROM task_dependency d JOIN task t ON t.id = d.successor_id WHERE t.project_id = ?`,
    projectId,
  );
  const bookings = all<Booking>('SELECT * FROM booking WHERE project_id = ? ORDER BY id', projectId)
    .filter(managed) as ReconcileBooking[];
  return { project, tasks, deps, bookings };
}

function projectStart(state: PlanState): ISODate {
  return state.project.start_date ?? defaultProjectStart(today(), holidaySet());
}

export function outcomeOf(state: PlanState): PlanOutcome | { cycle: number[] } {
  return planProject({
    projectStart: projectStart(state),
    tasks: state.tasks,
    deps: state.deps,
    bookings: state.bookings,
    holidays: holidaySet(),
  });
}

function cycleMessage(cycle: number[], tasks: readonly Task[]): string {
  const name = (id: number) => tasks.find((t) => t.id === id)?.name ?? `#${id}`;
  return `That would make a loop: ${cycle.map(name).join(' → ')}.`;
}

/**
 * Recompute a project's schedule and bookings from what is stored, and write the
 * result. Call inside a transaction: a loop throws, and the change that made it
 * rolls back with it.
 */
export function replan(projectId: number): PlanOutcome {
  const state = loadState(projectId);
  const outcome = outcomeOf(state);
  if ('cycle' in outcome) throw new PlanError(cycleMessage(outcome.cycle, state.tasks));

  // A plan needs an anchor that does not drift with the clock once work exists.
  if (!state.project.start_date && state.tasks.length) {
    run('UPDATE project SET start_date = ? WHERE id = ?', projectStart(state), projectId);
  }

  const before = new Map(state.tasks.map((t) => [t.id, t]));
  for (const t of outcome.tasks) {
    const was = before.get(t.id)!;
    if (was.start_date === t.start_date && was.end_date === t.end_date
      && was.total_float === t.total_float && was.critical === t.critical) continue;
    // Dates are what people argue about; a task's move is recorded like a booking's.
    if (was.start_date && was.start_date !== t.start_date) audit('task', t.id, 'start_date', was.start_date, t.start_date);
    if (was.end_date && was.end_date !== t.end_date) audit('task', t.id, 'end_date', was.end_date, t.end_date);
    run('UPDATE task SET start_date = ?, end_date = ?, total_float = ?, critical = ? WHERE id = ?',
      t.start_date, t.end_date, t.total_float, t.critical, t.id);
  }

  const { create, update, remove } = outcome.reconciliation;
  for (const id of remove) {
    audit('booking', id, 'removed_by_tasks', id, null);
    run('DELETE FROM booking WHERE id = ?', id);
  }
  for (const b of update) {
    const was = get<Booking>('SELECT * FROM booking WHERE id = ?', b.id!)!;
    if (was.start_date !== b.start_date) audit('booking', b.id!, 'start_date', was.start_date, b.start_date);
    if (was.end_date !== b.end_date) audit('booking', b.id!, 'end_date', was.end_date, b.end_date);
    run(
      `UPDATE booking SET start_date = ?, end_date = ?, kind = ?, hold_start = ?, hold_end = ?, hold_done = ? WHERE id = ?`,
      b.start_date, b.end_date, effectiveKind(was.kind, b.start_date, b.end_date),
      b.hold_start, b.hold_end, b.hold_done, b.id,
    );
  }
  for (const b of create) {
    const env = get<Environment>('SELECT * FROM environment WHERE id = ?', b.environment_id)!;
    const kind = effectiveKind(autoBookingKind(env.kind), b.start_date, b.end_date);
    const { lastInsertRowid } = run(
      `INSERT INTO booking (project_id, environment_id, kind, start_date, end_date, hold_start, hold_end, hold_done)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, b.environment_id, kind, b.start_date, b.end_date, b.hold_start, b.hold_end, b.hold_done,
    );
    audit('booking', Number(lastInsertRowid), 'created_by_tasks', null, `${b.start_date}..${b.end_date}`);
  }
  return outcome;
}

/** Replan every project that has tasks, after something global (the holiday table) moved. */
export function replanAll() {
  for (const { id } of all<{ id: number }>('SELECT DISTINCT project_id AS id FROM task')) replan(id);
}

// ---------------------------------------------------------------- changes

export type Predecessor = { id: number; lag: number };

export type TaskFields = Partial<Pick<Task,
  'name' | 'environment_id' | 'duration' | 'status' | 'not_before' | 'assignee' | 'note' | 'actual_start' | 'actual_end'>>
  & { predecessors?: Predecessor[] };

export type Change =
  | { op: 'create'; fields: TaskFields & { name: string }; after_id?: number | null }
  | { op: 'update'; id: number; fields: TaskFields }
  | { op: 'delete'; id: number; bridge?: boolean };

/** Temporary id for a task that has not been inserted yet. */
export const NEW_TASK_ID = -1;

/**
 * Status changes fill in what happened: starting work stamps the actual start,
 * finishing stamps the actual end, and going back to "to do" forgets both.
 */
function withActuals(t: Task, now: ISODate): Task {
  if (t.status === 'todo' || t.status === 'blocked') {
    return t.status === 'todo' ? { ...t, actual_start: null, actual_end: null } : t;
  }
  const started = t.actual_start ?? (t.start_date && t.start_date <= now ? t.start_date : now);
  if (t.status === 'in_progress') return { ...t, actual_start: started, actual_end: null };
  return { ...t, actual_start: started, actual_end: t.actual_end ?? (now < started ? started : now) };
}

/** Apply a change in memory. Validation lives here so a preview refuses what a save would. */
export function applyChange(state: PlanState, change: Change): PlanState {
  const now = today();
  let tasks = [...state.tasks];
  let deps = [...state.deps];

  const setPredecessors = (id: number, preds: Predecessor[] | undefined) => {
    if (!preds) return;
    const ids = new Set(tasks.map((t) => t.id));
    for (const p of preds) {
      if (!ids.has(p.id)) throw new PlanError('A predecessor must be a task in the same project');
      if (p.id === id) throw new PlanError('A task cannot come after itself');
    }
    deps = deps.filter((d) => d.successor_id !== id);
    const seen = new Set<number>();
    for (const p of preds) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      deps.push({ predecessor_id: p.id, successor_id: id, lag: Math.trunc(p.lag) || 0 });
    }
  };

  if (change.op === 'create') {
    const afterIndex = change.after_id != null ? tasks.findIndex((t) => t.id === change.after_id) : -1;
    const task: Task = {
      id: NEW_TASK_ID, project_id: state.project.id, environment_id: null, name: '', duration: 1, status: 'todo',
      not_before: null, assignee: null, note: null, sort_order: 0, actual_start: null, actual_end: null,
      start_date: null, end_date: null, total_float: null, critical: 0,
      ...stripPreds(change.fields),
    };
    tasks.splice(afterIndex >= 0 ? afterIndex + 1 : tasks.length, 0, withActuals(task, now));
    tasks = tasks.map((t, i) => ({ ...t, sort_order: i }));
    setPredecessors(NEW_TASK_ID, change.fields.predecessors);
  } else if (change.op === 'update') {
    const i = tasks.findIndex((t) => t.id === change.id);
    if (i < 0) throw new PlanError('Task not found');
    const next = { ...tasks[i], ...stripPreds(change.fields) };
    tasks[i] = next.status !== tasks[i].status ? withActuals(next, now) : next;
    setPredecessors(change.id, change.fields.predecessors);
  } else {
    if (!tasks.some((t) => t.id === change.id)) throw new PlanError('Task not found');
    const into = deps.filter((d) => d.successor_id === change.id);
    const outOf = deps.filter((d) => d.predecessor_id === change.id);
    tasks = tasks.filter((t) => t.id !== change.id);
    deps = deps.filter((d) => d.predecessor_id !== change.id && d.successor_id !== change.id);
    if (change.bridge) {
      // Keep the chain: each successor now waits on what the deleted task waited on.
      for (const a of into) {
        for (const b of outOf) {
          if (!deps.some((d) => d.predecessor_id === a.predecessor_id && d.successor_id === b.successor_id)) {
            deps.push({ predecessor_id: a.predecessor_id, successor_id: b.successor_id, lag: a.lag + b.lag });
          }
        }
      }
    }
  }
  return { ...state, tasks, deps };
}

function stripPreds(fields: TaskFields): Partial<Task> {
  const { predecessors: _, ...rest } = fields;
  return rest;
}

/** Write a changed state back: tasks inserted, updated or deleted, then the project's links replaced. */
export function writeState(before: PlanState, next: PlanState): number | null {
  const was = new Map(before.tasks.map((t) => [t.id, t]));
  const keep = new Set(next.tasks.map((t) => t.id));
  let createdId: number | null = null;

  for (const t of before.tasks) if (!keep.has(t.id)) run('DELETE FROM task WHERE id = ?', t.id);

  for (const t of next.tasks) {
    const cols = [t.environment_id, t.name, t.duration, t.status, t.not_before, t.assignee, t.note, t.sort_order,
      t.actual_start, t.actual_end];
    if (t.id === NEW_TASK_ID) {
      createdId = Number(run(
        `INSERT INTO task (project_id, environment_id, name, duration, status, not_before, assignee, note, sort_order,
                           actual_start, actual_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        next.project.id, ...cols,
      ).lastInsertRowid);
      continue;
    }
    const old = was.get(t.id)!;
    if (old.status !== t.status) audit('task', t.id, 'status', old.status, t.status);
    if (old.duration !== t.duration) audit('task', t.id, 'duration', old.duration, t.duration);
    run(
      `UPDATE task SET environment_id = ?, name = ?, duration = ?, status = ?, not_before = ?, assignee = ?, note = ?,
                       sort_order = ?, actual_start = ?, actual_end = ? WHERE id = ?`,
      ...cols, t.id,
    );
  }

  const idOf = (id: number) => (id === NEW_TASK_ID ? createdId! : id);
  const taskIds = next.tasks.map((t) => idOf(t.id));
  if (before.tasks.length) {
    run(`DELETE FROM task_dependency WHERE successor_id IN (${before.tasks.map(() => '?').join(',')})`,
      ...before.tasks.map((t) => t.id));
  }
  for (const d of next.deps) {
    if (!taskIds.includes(idOf(d.predecessor_id)) || !taskIds.includes(idOf(d.successor_id))) continue;
    // Links are rewritten wholesale; a hand-shaped arrow must survive an unrelated edit.
    const kept = before.deps.find((b) => b.predecessor_id === d.predecessor_id && b.successor_id === d.successor_id);
    run(`INSERT INTO task_dependency (predecessor_id, successor_id, lag, route_out, route_y, route_in, route_from, route_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      idOf(d.predecessor_id), idOf(d.successor_id), d.lag,
      kept?.route_out ?? null, kept?.route_y ?? null, kept?.route_in ?? null, kept?.route_from ?? null, kept?.route_to ?? null);
  }
  return createdId;
}

/** What a change would do, without doing it. */
export function previewChange(projectId: number, change: Change): PlanImpact {
  const state = loadState(projectId);
  const before = outcomeOf(state);
  if ('cycle' in before) throw new PlanError(cycleMessage(before.cycle, state.tasks));
  const after = outcomeOf(applyChange(state, change));

  const teamId = state.project.team_id;
  return planImpact(before, after, {
    project: { id: projectId, name: state.project.name, priority: state.project.priority, target_date: state.project.target_date },
    teamBookings: listBookings({ teamId }),
    environments: listEnvironments(teamId),
    resolved: new Set(all<{ key: string }>(
      'SELECT r.key FROM conflict_resolution r JOIN environment e ON e.id = r.environment_id WHERE e.team_id = ?', teamId,
    ).map((r) => r.key)),
    holidays: holidaySet(),
    deletedTaskId: change.op === 'delete' ? change.id : undefined,
  });
}

export const TASK_STATUS_VALUES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
