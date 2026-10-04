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
import { autoBookingKind, isManaged, type ReconcileBooking } from '../shared/taskHolds.ts';
import { defaultProjectStart } from '../shared/schedule.ts';
import { descendants, inOutlineOrder, MAX_DEPTH, outline, parentOf, summaryIds, type OutlinePlacement } from '../shared/wbs.ts';
import { effectiveKind } from '../shared/bookings.ts';
import { nextTaskCode } from '../shared/taskCode.ts';
import { today, workingDays } from '../shared/dates.ts';
import type {
  Booking, Environment, ISODate, LinkType, PlanImpact, Project, Task, TaskDependency, TaskStatus,
} from '../shared/types.ts';

export class PlanError extends Error {}

export type PlanState = {
  project: Project;
  tasks: Task[];
  deps: TaskDependency[];
  bookings: ReconcileBooking[];
};


export function loadState(projectId: number): PlanState {
  const project = get<Project>('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw new PlanError('Project not found');
  // Outline order, so a create placed "after" a row lands where the table shows it.
  const tasks = inOutlineOrder(all<Task>('SELECT * FROM task WHERE project_id = ? ORDER BY sort_order, id', projectId));
  const deps = all<TaskDependency>(
    `SELECT d.* FROM task_dependency d JOIN task t ON t.id = d.successor_id WHERE t.project_id = ?`,
    projectId,
  );
  const bookings = all<Booking>('SELECT * FROM booking WHERE project_id = ? ORDER BY id', projectId)
    .filter((b) => isManaged(b)) as ReconcileBooking[];
  return { project, tasks, deps, bookings };
}

export function projectStart(state: PlanState): ISODate {
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
  // A summary's status and actuals are rolled up, and stored so every reader agrees.
  for (const t of outcome.tasks) {
    if (!outcome.schedule.tasks.get(t.id)?.summary) continue;
    const was = before.get(t.id)!;
    if (was.status === t.status && was.actual_start === t.actual_start && was.actual_end === t.actual_end) continue;
    if (was.status !== t.status) audit('task', t.id, 'status', was.status, t.status);
    run('UPDATE task SET status = ?, actual_start = ?, actual_end = ?, progress = NULL WHERE id = ?',
      t.status, t.actual_start, t.actual_end, t.id);
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

export type Predecessor = { id: number; lag: number; type?: LinkType };

export type TaskFields = Partial<Pick<Task,
  'name' | 'environment_id' | 'duration' | 'status' | 'not_before' | 'note' | 'actual_start' | 'actual_end'
  | 'parent_id' | 'progress' | 'code' | 'deadline'>>
  & { predecessors?: Predecessor[] };

export type Change =
  | { op: 'create'; fields: TaskFields & { name: string }; after_id?: number | null }
  | { op: 'update'; id: number; fields: TaskFields }
  /** `children`: a summary's tasks go with it ('delete') or move up a level ('lift', the default). */
  | { op: 'delete'; id: number; bridge?: boolean; children?: 'lift' | 'delete' }
  /** Indent, outdent or move within the outline: new parents and sibling orders. */
  | { op: 'outline'; placements: OutlinePlacement[] };

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
      deps.push({ predecessor_id: p.id, successor_id: id, lag: Math.trunc(p.lag) || 0, type: p.type ?? 'FS' });
    }
  };
  /** Last among its new siblings, so a task given a parent lands at the end of it. */
  const lastUnder = (parent: number | null, self: number) =>
    1 + Math.max(-1, ...tasks.filter((t) => (t.parent_id ?? null) === parent && t.id !== self).map((t) => t.sort_order));

  if (change.op === 'create') {
    let afterIndex = change.after_id != null ? tasks.findIndex((t) => t.id === change.after_id) : -1;
    // A new row joins the level of the row it follows, the way outlines behave.
    const inherited = afterIndex >= 0 ? tasks[afterIndex].parent_id ?? null : null;
    const task: Task = {
      id: NEW_TASK_ID, project_id: state.project.id, environment_id: null, name: '', duration: 1, status: 'todo',
      not_before: null, deadline: null, note: null, sort_order: 0, actual_start: null, actual_end: null,
      start_date: null, end_date: null, total_float: null, critical: 0, parent_id: inherited, progress: null,
      code: nextTaskCode(tasks),
      ...stripPreds(change.fields),
    };
    if ('parent_id' in change.fields && task.parent_id != null) {
      // Given a summary, it goes last under it: after the summary's last row.
      const under = descendants(tasks, task.parent_id);
      afterIndex = Math.max(tasks.findIndex((t) => t.id === task.parent_id), ...tasks.map((t, n) => (under.has(t.id) ? n : -1)));
    }
    // tasks is in outline order, so renumbering by position keeps every sibling order.
    tasks.splice(afterIndex >= 0 ? afterIndex + 1 : tasks.length, 0, withActuals(task, now));
    tasks = tasks.map((t, i) => ({ ...t, sort_order: i }));
    setPredecessors(NEW_TASK_ID, change.fields.predecessors);
  } else if (change.op === 'update') {
    const i = tasks.findIndex((t) => t.id === change.id);
    if (i < 0) throw new PlanError('Task not found');
    if (summaryIds(tasks).has(change.id)) refuseSummaryFields(tasks[i], change.fields);
    const next = { ...tasks[i], ...stripPreds(change.fields) };
    if ('parent_id' in change.fields && (change.fields.parent_id ?? null) !== (tasks[i].parent_id ?? null)) {
      next.sort_order = lastUnder(next.parent_id ?? null, next.id);
    }
    tasks[i] = next.status !== tasks[i].status ? withActuals(next, now) : next;
    setPredecessors(change.id, change.fields.predecessors);
  } else if (change.op === 'outline') {
    const at = new Map(change.placements.map((p) => [p.id, p]));
    for (const id of at.keys()) if (!tasks.some((t) => t.id === id)) throw new PlanError('Task not found');
    tasks = tasks.map((t) => (at.has(t.id) ? { ...t, parent_id: at.get(t.id)!.parent_id, sort_order: at.get(t.id)!.sort_order } : t));
  } else {
    const gone = tasks.find((t) => t.id === change.id);
    if (!gone) throw new PlanError('Task not found');
    // The branch that goes: the task alone, or with everything under it.
    const branch = new Set([change.id, ...(change.children === 'delete' ? descendants(tasks, change.id) : [])]);
    if (change.children !== 'delete') {
      // A deleted summary's tasks move up a level into its place, never with it.
      const siblings = outline(tasks).filter((r) => r.parent_id === (gone.parent_id ?? null)).map((r) => r.id);
      const children = outline(tasks).filter((r) => r.parent_id === gone.id).map((r) => r.id);
      siblings.splice(siblings.indexOf(gone.id), 1, ...children);
      const order = new Map(siblings.map((id, n) => [id, n]));
      tasks = tasks.map((t) => (order.has(t.id) ? { ...t, parent_id: gone.parent_id ?? null, sort_order: order.get(t.id)! } : t));
    }
    // Links crossing into and out of the branch; those inside it go with it.
    const into = deps.filter((d) => branch.has(d.successor_id) && !branch.has(d.predecessor_id));
    const outOf = deps.filter((d) => branch.has(d.predecessor_id) && !branch.has(d.successor_id));
    tasks = tasks.filter((t) => !branch.has(t.id));
    deps = deps.filter((d) => !branch.has(d.predecessor_id) && !branch.has(d.successor_id));
    if (change.bridge) {
      // Keep the chain: each successor now waits on what the deleted work waited on.
      for (const a of into) {
        for (const b of outOf) {
          if (a.predecessor_id === b.successor_id) continue;
          if (!deps.some((d) => d.predecessor_id === a.predecessor_id && d.successor_id === b.successor_id)) {
            deps.push({ predecessor_id: a.predecessor_id, successor_id: b.successor_id, lag: a.lag + b.lag, type: 'FS' });
          }
        }
      }
    }
  }
  checkCodes(tasks, change.op === 'create' ? NEW_TASK_ID : change.op === 'update' ? change.id : null);
  // Moving a task under a summary makes any link between them meaningless (the
  // summary is made of it), so an outline change drops it rather than refusing.
  const moved = change.op === 'outline' || (change.op !== 'delete' && 'parent_id' in change.fields && !change.fields.predecessors);
  if (moved) {
    deps = deps.filter((d) => !descendants(tasks, d.predecessor_id).has(d.successor_id)
      && !descendants(tasks, d.successor_id).has(d.predecessor_id));
  }
  tasks = passEnvironmentDown(state.tasks, tasks);
  tasks = revertFormerSummaries(state.tasks, tasks);
  return { ...state, ...checkOutline(tasks, deps) };
}

/** The fields a summary does not have: they are its tasks', rolled up (the 100% rule). */
function refuseSummaryFields(t: Task, f: TaskFields) {
  const sent = (k: keyof TaskFields) => k in f && (f[k] ?? null) !== (t[k as keyof Task] ?? null);
  if (sent('status')) throw new PlanError(`${t.name} is a summary: its status comes from the tasks under it`);
  if (sent('duration')) throw new PlanError(`${t.name} is a summary: its length comes from the tasks under it`);
  if (sent('actual_start') || sent('actual_end')) throw new PlanError(`${t.name} is a summary: its actual dates come from the tasks under it`);
  if (f.progress != null) throw new PlanError(`${t.name} is a summary: its progress comes from the tasks under it`);
  if (f.environment_id != null) throw new PlanError(`${t.name} is a summary and books nothing; give its tasks the environment`);
}

/**
 * A task that becomes a summary hands its environment to the sub-tasks it just
 * gained that have none, so its booking moves down to the work instead of
 * vanishing when checkOutline clears it.
 */
function passEnvironmentDown(before: readonly Task[], after: Task[]): Task[] {
  const wasSummary = summaryIds(before);
  const was = new Map(before.map((t) => [t.id, t]));
  const env = new Map<number, number>();
  for (const id of summaryIds(after)) {
    const t = after.find((x) => x.id === id)!;
    if (!wasSummary.has(id) && t.environment_id != null) env.set(id, t.environment_id);
  }
  if (!env.size) return after;
  const summaries = summaryIds(after);
  return after.map((t) => {
    const e = t.parent_id != null ? env.get(t.parent_id) : undefined;
    const joined = (was.get(t.id)?.parent_id ?? null) !== (t.parent_id ?? null);
    return e != null && joined && t.environment_id == null && !summaries.has(t.id) ? { ...t, environment_id: e } : t;
  });
}

/**
 * A summary whose last task left is a task again. It keeps the length it showed
 * as a summary, not whatever Days it had before it became one.
 */
function revertFormerSummaries(before: readonly Task[], after: Task[]): Task[] {
  const wasSummary = summaryIds(before);
  const isSummary = summaryIds(after);
  if (![...wasSummary].some((id) => !isSummary.has(id))) return after;
  const holidays = holidaySet();
  return after.map((t) => {
    if (!wasSummary.has(t.id) || isSummary.has(t.id) || !t.start_date || !t.end_date) return t;
    return { ...t, duration: workingDays(t.start_date, t.end_date, holidays), progress: null };
  });
}

/**
 * The rules an outline keeps, checked after every change: parents in the plan and
 * never under themselves, a bounded depth, no link between a task and its own
 * summary, only finish-to-start links on summaries, and no summary booking an
 * environment (its tasks do that).
 */
export function checkOutline(tasks: Task[], deps: TaskDependency[]): { tasks: Task[]; deps: TaskDependency[] } {
  const ids = new Set(tasks.map((t) => t.id));
  const name = (id: number) => tasks.find((t) => t.id === id)?.name ?? `#${id}`;
  for (const t of tasks) {
    if (t.parent_id == null) continue;
    if (!ids.has(t.parent_id)) throw new PlanError('A summary must be a task in the same project');
    if (t.parent_id === t.id) throw new PlanError('A task cannot sit under itself');
  }
  const parent = parentOf(tasks);
  for (const t of tasks) {
    if ((parent.get(t.id) ?? null) !== (t.parent_id ?? null)) throw new PlanError(`${name(t.id)} cannot sit under one of its own tasks`);
  }
  if (outline(tasks).some((r) => r.depth >= MAX_DEPTH)) throw new PlanError(`An outline can be at most ${MAX_DEPTH} levels deep`);

  const summaries = summaryIds(tasks);
  for (const d of deps) {
    if (descendants(tasks, d.predecessor_id).has(d.successor_id) || descendants(tasks, d.successor_id).has(d.predecessor_id)) {
      throw new PlanError(`${name(d.successor_id)} and ${name(d.predecessor_id)} are in the same summary line; link the tasks inside it instead`);
    }
    if ((summaries.has(d.predecessor_id) || summaries.has(d.successor_id)) && (d.type ?? 'FS') !== 'FS') {
      const summary = summaries.has(d.successor_id) ? d.successor_id : d.predecessor_id;
      throw new PlanError(`${name(summary)} would be a summary, and links to or from a summary are finish-to-start only: `
        + `${name(d.predecessor_id)} → ${name(d.successor_id)} is ${d.type}. Make that link FS first`);
    }
  }
  return {
    tasks: tasks.map((t) => (summaries.has(t.id) && t.environment_id != null ? { ...t, environment_id: null } : t)),
    deps,
  };
}

/** Two tasks of a plan never share a TaskID: After would not know which one it means. */
function checkCodes(tasks: readonly Task[], changed: number | null) {
  const seen = new Map<number, Task>();
  for (const t of tasks) {
    if (t.code == null) continue;
    const other = seen.get(t.code);
    if (other) {
      const holder = other.id === changed ? t : other;
      throw new PlanError(`ID ${t.code} is already ${holder.name}; pick another`);
    }
    seen.set(t.code, t);
  }
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
    const cols = [t.environment_id, t.name, t.duration, t.status, t.not_before, t.note, t.sort_order,
      t.actual_start, t.actual_end, t.parent_id ?? null, t.progress ?? null, t.code ?? null, t.deadline ?? null];
    if (t.id === NEW_TASK_ID) {
      createdId = Number(run(
        `INSERT INTO task (project_id, environment_id, name, duration, status, not_before, note, sort_order,
                           actual_start, actual_end, parent_id, progress, code, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        next.project.id, ...cols,
      ).lastInsertRowid);
      continue;
    }
    const old = was.get(t.id)!;
    if (old.status !== t.status) audit('task', t.id, 'status', old.status, t.status);
    if (old.duration !== t.duration) audit('task', t.id, 'duration', old.duration, t.duration);
    if ((old.parent_id ?? null) !== (t.parent_id ?? null)) audit('task', t.id, 'parent_id', old.parent_id, t.parent_id);
    if ((old.code ?? null) !== (t.code ?? null)) audit('task', t.id, 'code', old.code, t.code);
    if ((old.deadline ?? null) !== (t.deadline ?? null)) audit('task', t.id, 'deadline', old.deadline ?? null, t.deadline ?? null);
    run(
      `UPDATE task SET environment_id = ?, name = ?, duration = ?, status = ?, not_before = ?, note = ?,
                       sort_order = ?, actual_start = ?, actual_end = ?, parent_id = ?, progress = ?, code = ?, deadline = ? WHERE id = ?`,
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
    run(`INSERT INTO task_dependency (predecessor_id, successor_id, lag, type, route_out, route_y, route_in, route_from, route_to)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      idOf(d.predecessor_id), idOf(d.successor_id), d.lag, d.type ?? 'FS',
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
    deletedTaskIds: change.op === 'delete'
      ? [change.id, ...(change.children === 'delete' ? descendants(state.tasks, change.id) : [])]
      : undefined,
  });
}

export const TASK_STATUS_VALUES: readonly TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];
