import { all } from './db.ts';
import { calendarDays, workingDays } from '../shared/dates.ts';
import { releaseFrom, taskSpan } from '../shared/taskHolds.ts';
import type { Baseline, BaselineTask, BookingView, ElsewhereTask, Environment, Holiday, ISODate, Project, Resource, Task, Team } from '../shared/types.ts';

type RawBooking = Omit<BookingView, 'calendar_days' | 'working_days' | 'is_milestone' | 'auto' | 'tasks' | 'release_from'>;

/** A project's baselines, oldest first, with how many tasks each holds. */
export function listBaselines(projectId: number): Baseline[] {
  return all<Baseline>(
    `SELECT b.id, b.project_id, b.name, b.saved_at, b.finish,
            (SELECT COUNT(*) FROM task_baseline tb WHERE tb.baseline_id = b.id) AS tasks
     FROM baseline b WHERE b.project_id = ? ORDER BY b.saved_at, b.id`,
    projectId,
  );
}

/** The tasks of one baseline. */
export function baselineTasks(baselineId: number): BaselineTask[] {
  return all<BaselineTask>(
    'SELECT task_id, start_date, end_date, duration FROM task_baseline WHERE baseline_id = ?', baselineId,
  );
}

/**
 * The baseline a project compares with, by task id: the one thing ghost bars,
 * variance and the assistant read. Empty when it has none.
 */
export function compareBaseline(projectId: number): Map<number, { start: ISODate; end: ISODate; duration: number | null }> {
  return new Map(all<BaselineTask>(
    `SELECT tb.task_id, tb.start_date, tb.end_date, tb.duration FROM task_baseline tb
     JOIN project p ON p.compare_baseline_id = tb.baseline_id WHERE p.id = ?`,
    projectId,
  ).map((b) => [b.task_id, { start: b.start_date, end: b.end_date, duration: b.duration }]));
}

export function holidaySet(): Set<ISODate> {
  return new Set(all<Holiday>('SELECT date, name FROM holiday').map((h) => h.date));
}

/** Teams carry the counts a delete confirmation needs to be honest. */
export function listTeams(): Team[] {
  return all<Team>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM project p WHERE p.team_id = t.id) AS project_count,
            (SELECT COUNT(*) FROM booking b
               JOIN project p ON p.id = b.project_id
              WHERE p.team_id = t.id) AS booking_count,
            (SELECT COUNT(*) FROM task k
               JOIN project p ON p.id = k.project_id
              WHERE p.team_id = t.id) AS task_count
       FROM team t
      ORDER BY t.active DESC, t.name`,
  );
}

export function listEnvironments(teamId?: number): Environment[] {
  const where = teamId == null ? '' : 'WHERE e.team_id = ?';
  const params = teamId == null ? [] : [teamId];
  return all<Environment>(
    `SELECT e.*,
            (SELECT COUNT(*) FROM booking b WHERE b.environment_id = e.id) AS booking_count,
            (SELECT COUNT(*) FROM task k WHERE k.environment_id = e.id) AS task_count
       FROM environment e
       ${where}
      ORDER BY e.team_id, e.sort_order, e.name`,
    ...params,
  );
}

/** Projects with their total booking count, window-independent. */
export function listProjects(teamId?: number): Project[] {
  const where = teamId == null ? '' : 'WHERE p.team_id = ?';
  const params = teamId == null ? [] : [teamId];
  return all<Project>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM booking b WHERE b.project_id = p.id) AS booking_count,
            (SELECT COUNT(*) FROM task k WHERE k.project_id = p.id) AS task_count
       FROM project p
       ${where}
      ORDER BY p.name`,
    ...params,
  );
}

export function listHolidays(): Holiday[] {
  return all<Holiday>('SELECT date, name FROM holiday ORDER BY date');
}

/**
 * Bookings enriched with the project/environment facts the board and the conflict
 * engine both need, so neither has to join anything at render time.
 */
export function listBookings(filter: {
  teamId?: number;
  envIds?: number[];
  from?: ISODate;
  to?: ISODate;
} = {}): BookingView[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.teamId != null) {
    where.push('p.team_id = ?');
    params.push(filter.teamId);
  }
  if (filter.envIds?.length) {
    where.push(`b.environment_id IN (${filter.envIds.map(() => '?').join(',')})`);
    params.push(...filter.envIds);
  }
  // Overlap, not containment: a booking straddling the window edge must still appear.
  if (filter.from) {
    where.push('b.end_date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('b.start_date <= ?');
    params.push(filter.to);
  }

  const rows = all<RawBooking>(
    `SELECT b.*,
            p.name     AS project_name,
            p.team_id  AS team_id,
            p.priority AS priority,
            e.name     AS env_name,
            e.kind     AS env_kind,
            e.capacity AS capacity
       FROM booking b
       JOIN project p     ON p.id = b.project_id
       JOIN environment e ON e.id = b.environment_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.start_date, b.id`,
    ...params,
  );

  const holidays = holidaySet();
  const tasks = tasksOnEnvironments(rows.filter((r) => r.hold_start).map((r) => r.project_id));
  return rows.map((r) => {
    const held = r.hold_start && r.hold_end
      ? tasks.filter((t) => t.project_id === r.project_id && t.environment_id === r.environment_id
        && t.span.start >= r.hold_start! && t.span.end <= r.hold_end!)
      : [];
    return {
      ...r,
      calendar_days: calendarDays(r.start_date, r.end_date),
      working_days: workingDays(r.start_date, r.end_date, holidays),
      // A release is a moment, not a span, and the renderer draws it as a diamond.
      is_milestone: r.kind === 'RELEASE' || r.start_date === r.end_date,
      auto: r.manual_start == null || r.manual_end == null,
      tasks: held.map((t) => ({ id: t.id, name: t.name, start: t.span.start, end: t.span.end })),
      release_from: r.hold_end
        ? releaseFrom(r.end_date, { end: r.hold_end, done: Boolean(r.hold_done) })
        : null,
    };
  });
}

/** Environment tasks of the given projects with their calendar spans, for labelling bookings. */
function tasksOnEnvironments(projectIds: number[]) {
  const ids = [...new Set(projectIds)];
  if (!ids.length) return [];
  return all<Task>(
    `SELECT * FROM task WHERE environment_id IS NOT NULL AND duration > 0
        AND project_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  ).flatMap((t) => {
    const span = taskSpan(t);
    return span ? [{ id: t.id, project_id: t.project_id, environment_id: t.environment_id!, name: t.name, span }] : [];
  });
}

export function listTasks(projectId: number): Task[] {
  const who = new Map<number, number[]>();
  for (const r of all<{ task_id: number; resource_id: number }>(
    `SELECT tr.task_id, tr.resource_id FROM task_resource tr JOIN task t ON t.id = tr.task_id
     WHERE t.project_id = ? ORDER BY tr.task_id, tr.sort_order`, projectId,
  )) {
    if (!who.has(r.task_id)) who.set(r.task_id, []);
    who.get(r.task_id)!.push(r.resource_id);
  }
  return all<Task>('SELECT * FROM task WHERE project_id = ? ORDER BY sort_order, id', projectId)
    .map((t) => ({ ...t, resource_ids: who.get(t.id) ?? [] }));
}

/**
 * The work this plan's people have in other projects: leaf tasks with dates that
 * are not done, so the plan can warn when someone is on two tasks at once
 * (`personOverlaps` in shared/workload.ts decides what counts as a clash).
 */
export function workElsewhere(projectId: number): ElsewhereTask[] {
  const rows = all<Omit<ElsewhereTask, 'resource_ids'> & { resource_id: number }>(
    `SELECT t.id AS task_id, t.project_id, p.name AS project_name, t.code, t.name,
            t.start_date AS start, t.end_date AS end, tr.resource_id
     FROM task_resource tr
     JOIN task t ON t.id = tr.task_id
     JOIN project p ON p.id = t.project_id
     WHERE t.project_id <> ? AND t.status <> 'done' AND t.duration > 0
       AND t.start_date IS NOT NULL AND t.end_date IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM task c WHERE c.parent_id = t.id)
       AND tr.resource_id IN (SELECT tr2.resource_id FROM task_resource tr2 JOIN task t2 ON t2.id = tr2.task_id WHERE t2.project_id = ?)
     ORDER BY t.start_date, t.id, tr.sort_order`,
    projectId, projectId,
  );
  const byTask = new Map<number, ElsewhereTask>();
  for (const { resource_id, ...t } of rows) {
    if (!byTask.has(t.task_id)) byTask.set(t.task_id, { ...t, resource_ids: [] });
    byTask.get(t.task_id)!.resource_ids.push(resource_id);
  }
  return [...byTask.values()];
}

/** Every person, with how much they are on; for the Resources dialog and the Who suggestions. */
export function listResources(): Resource[] {
  return all<Resource>(
    `SELECT r.id, r.name, r.active,
            COUNT(tr.task_id) AS task_count, COUNT(DISTINCT t.project_id) AS project_count
     FROM resource r
     LEFT JOIN task_resource tr ON tr.resource_id = r.id
     LEFT JOIN task t ON t.id = tr.task_id
     GROUP BY r.id ORDER BY r.name COLLATE NOCASE`,
  );
}

/** Keys of the resolved double-bookings for a team's environments, or every team's. */
export function resolvedKeys(teamId?: number): string[] {
  const rows = teamId != null
    ? all<{ key: string }>(
      `SELECT r.key FROM conflict_resolution r JOIN environment e ON e.id = r.environment_id WHERE e.team_id = ?`,
      teamId,
    )
    : all<{ key: string }>('SELECT key FROM conflict_resolution');
  return rows.map((r) => r.key);
}
