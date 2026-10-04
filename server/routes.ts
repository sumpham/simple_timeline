import { Router, type Request, type Response, type NextFunction } from 'express';
import { all, audit, ensureResources, get, run, setTaskResources, transaction } from './db.ts';
import { listBookings, listEnvironments, listHolidays, listProjects, listResources, listTeams, resolvedKeys, workElsewhere } from './queries.ts';
import { applyResolutions, conflictKey, detectConflicts } from '../shared/conflicts.ts';
import { isValidISODate, isWorkingDay, snapToWorkingDay } from '../shared/dates.ts';
import { effectiveKind } from '../shared/bookings.ts';
import { baselineTasks, compareBaseline, holidaySet, listBaselines, listTasks } from './queries.ts';
import { plannedCosts, projectEarnedValue } from './money.ts';
import { applyChange, checkOutline, loadState, outcomeOf, PlanError, downstreamProjects, previewChange, projectEdges, projectNames, replanAll, replanWithDownstream, writeState, type Change, type TaskFields } from './plan.ts';
import { projectOrder } from '../shared/projectLinks.ts';
import { lateBy } from '../shared/schedule.ts';
import { TASK_CODE_MAX } from '../shared/taskCode.ts';
import { ESTIMATE_MAX, estimateError, type Estimate } from '../shared/estimates.ts';
import { cleanSettingsPatch } from '../shared/assistant/settings.ts';
import { providerStatus } from './llm/index.ts';
import { advisorReply, applyOps, assistantReport, assistantSettings, opsFrom, previewOps, reviewOps, StaleError, suggestionReport } from './assistant.ts';
import { cleanResourceName, formatResources, parseResources, RESOURCE_NAME_MAX, resourceKey } from '../shared/resources.ts';
import {
  BASELINE_NAME_MAX, BASELINES_MAX, LINK_TYPES, MARKERS, TASK_STATUSES, type ExternalLink, type LinkType, type Booking, type BookingKind, type Environment, type ISODate, type Marker, type Project,
  type Task,
} from '../shared/types.ts';

export const router = Router();

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const bad = (msg: string) => new HttpError(400, msg);
const missing = (what: string) => new HttpError(404, `${what} not found`);

/** Wraps a handler so thrown errors reach the error middleware instead of hanging the request. */
function handle(fn: (req: Request, res: Response) => void) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      fn(req, res);
    } catch (err) {
      next(err);
    }
  };
}

function intParam(value: unknown): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isInteger(n) ? n : undefined;
}

function intList(value: unknown): number[] | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  const ids = value.split(',').map(Number).filter(Number.isInteger);
  return ids.length ? ids : undefined;
}

function requireDate(value: unknown, field: string): ISODate {
  if (!isValidISODate(value)) throw bad(`${field} must be a real date in YYYY-MM-DD form`);
  return value;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if (value == null && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw bad(`${field} must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

/** A date that may be cleared: null or blank clears, anything else must be real. */
function optionalDate(value: unknown, field: string): ISODate | null {
  if (value == null || value === '') return null;
  return requireDate(value, field);
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw bad(`${field} is required`);
  return value.trim();
}

const ENV_KINDS = ['SIT', 'UAT', 'NFT', 'PENTEST', 'PROD', 'OTHER'] as const;
const BOOKING_KINDS = ['SIT', 'UAT', 'NFT', 'PENTEST', 'RELEASE', 'CUSTOM'] as const;
const STATUSES = ['planned', 'in_progress', 'on_hold', 'done', 'cancelled'] as const;
const PRIORITIES = ['low', 'normal', 'high', 'critical'] as const;
const CONFIDENCES = ['committed', 'tentative'] as const;

// ---------------------------------------------------------------- health

/** Liveness: the process is up. Deliberately touches nothing else. */
router.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

/**
 * Readiness: the database answers. A pod that cannot read its own data should
 * not receive traffic, so this query is the point of the endpoint.
 */
router.get('/readyz', handle((_req, res) => {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM team');
  res.json({ status: 'ready', teams: row?.n ?? 0 });
}));

// ---------------------------------------------------------------- bootstrap

router.get('/bootstrap', handle((_req, res) => {
  res.json({
    teams: listTeams(),
    environments: listEnvironments(),
    holidays: listHolidays(),
  });
}));

// ---------------------------------------------------------------- board

router.get('/board', handle((req, res) => {
  const teamId = intParam(req.query.team);
  const envIds = intList(req.query.envs);
  const from = isValidISODate(req.query.from) ? (req.query.from as ISODate) : undefined;
  const to = isValidISODate(req.query.to) ? (req.query.to as ISODate) : undefined;

  const bookings = listBookings({ teamId, envIds, from, to });
  const projects = listProjects(teamId);

  // Conflicts are computed over the team's whole environment set, not the filtered
  // subset: hiding a lane must not make its double-bookings disappear.
  const unfiltered = listBookings({ teamId, from, to });

  // The client needs the keys as well as the stamped conflicts: a drag preview
  // recomputes conflicts locally and must still know which ones are accepted.
  const resolved = resolvedKeys(teamId);

  res.json({
    bookings,
    projects,
    environments: listEnvironments(teamId),
    conflicts: applyResolutions(detectConflicts(unfiltered), new Set(resolved)),
    resolved,
  });
}));

router.get('/conflicts', handle((req, res) => {
  const teamId = intParam(req.query.team);
  const from = isValidISODate(req.query.from) ? (req.query.from as ISODate) : undefined;
  const to = isValidISODate(req.query.to) ? (req.query.to as ISODate) : undefined;
  const includeTentative = req.query.tentative === '1';
  res.json(applyResolutions(
    detectConflicts(listBookings({ teamId, from, to }), { includeTentative }),
    new Set(resolvedKeys(teamId)),
  ));
}));

/** The environment and booking ids that identify one double-booking. */
function conflictIdentity(body: unknown) {
  const b = body as { environment_id?: unknown; booking_ids?: unknown } | undefined;
  const envId = intParam(b?.environment_id);
  if (envId == null || !get('SELECT id FROM environment WHERE id = ?', envId)) {
    throw bad('A valid environment is required');
  }
  const ids = Array.isArray(b?.booking_ids) ? b.booking_ids.map(intParam) : [];
  if (ids.length < 2 || ids.some((id) => id == null)) throw bad('A double-booking involves at least two bookings');
  return { envId, key: conflictKey({ environment_id: envId, booking_ids: ids as number[] }) };
}

router.post('/conflicts/resolve', handle((req, res) => {
  const { envId, key } = conflictIdentity(req.body);
  run('INSERT OR IGNORE INTO conflict_resolution (key, environment_id) VALUES (?, ?)', key, envId);
  audit('conflict', envId, 'resolved', null, key);
  res.status(201).json({ key, resolved: true });
}));

router.post('/conflicts/reopen', handle((req, res) => {
  const { envId, key } = conflictIdentity(req.body);
  run('DELETE FROM conflict_resolution WHERE key = ?', key);
  audit('conflict', envId, 'resolved', key, null);
  res.json({ key, resolved: false });
}));

// ---------------------------------------------------------------- teams

const DEFAULT_ENVS = [
  { name: 'SIT', kind: 'SIT' },
  { name: 'UAT', kind: 'UAT' },
  { name: 'PROD', kind: 'PROD' },
] as const;

router.post('/teams', handle((req, res) => {
  const name = nonEmpty(req.body?.name, 'Team name');
  const code = (req.body?.code ?? name.slice(0, 3)).toString().trim().toUpperCase();

  if (get('SELECT id FROM team WHERE name = ?', name)) {
    throw bad(`A team called ${name} already exists`);
  }

  const team = transaction(() => {
    const { lastInsertRowid } = run('INSERT INTO team (name, code) VALUES (?, ?)', name, code);
    const id = Number(lastInsertRowid);
    // Seed the standard environments so a new team is never a blank wall.
    DEFAULT_ENVS.forEach((env, i) => {
      run('INSERT INTO environment (team_id, name, kind, sort_order) VALUES (?, ?, ?, ?)', id, env.name, env.kind, i);
    });
    return get('SELECT * FROM team WHERE id = ?', id);
  });

  res.status(201).json(team);
}));

router.patch('/teams/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<{ id: number; name: string; code: string; active: number }>('SELECT * FROM team WHERE id = ?', id);
  if (!existing) throw missing('Team');

  const name = req.body?.name != null ? nonEmpty(req.body.name, 'Team name') : existing.name;
  const code = req.body?.code != null ? String(req.body.code).trim().toUpperCase() : existing.code;
  const active = req.body?.active != null ? (req.body.active ? 1 : 0) : existing.active;

  run('UPDATE team SET name = ?, code = ?, active = ? WHERE id = ?', name, code, active, id);
  res.json(get('SELECT * FROM team WHERE id = ?', id));
}));

router.delete('/teams/:id', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM team WHERE id = ?', id)) throw missing('Team');
  run('DELETE FROM team WHERE id = ?', id);
  res.status(204).end();
}));

// ---------------------------------------------------------------- environments

router.post('/environments', handle((req, res) => {
  const teamId = intParam(req.body?.team_id);
  if (teamId == null || !get('SELECT id FROM team WHERE id = ?', teamId)) throw bad('A valid team is required');

  const name = nonEmpty(req.body?.name, 'Environment name');
  const kind = oneOf(req.body?.kind, ENV_KINDS, 'kind', 'OTHER');
  const capacity = Math.max(1, intParam(req.body?.capacity) ?? 1);

  if (get('SELECT id FROM environment WHERE team_id = ? AND name = ?', teamId, name)) {
    throw bad(`This team already has an environment called ${name}`);
  }

  const order = get<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM environment WHERE team_id = ?', teamId);
  const { lastInsertRowid } = run(
    'INSERT INTO environment (team_id, name, kind, capacity, sort_order) VALUES (?, ?, ?, ?, ?)',
    teamId, name, kind, capacity, order?.n ?? 0,
  );
  res.status(201).json(get('SELECT * FROM environment WHERE id = ?', Number(lastInsertRowid)));
}));

router.patch('/environments/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<Environment>('SELECT * FROM environment WHERE id = ?', id);
  if (!existing) throw missing('Environment');

  const name = req.body?.name != null ? nonEmpty(req.body.name, 'Environment name') : existing.name;
  const kind = req.body?.kind != null ? oneOf(req.body.kind, ENV_KINDS, 'kind') : existing.kind;
  const capacity = req.body?.capacity != null ? Math.max(1, Number(req.body.capacity)) : existing.capacity;

  if (capacity !== existing.capacity) audit('environment', id, 'capacity', existing.capacity, capacity);
  run('UPDATE environment SET name = ?, kind = ?, capacity = ? WHERE id = ?', name, kind, capacity, id);
  res.json(get('SELECT * FROM environment WHERE id = ?', id));
}));

router.delete('/environments/:id', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM environment WHERE id = ?', id)) throw missing('Environment');

  const inUse = get<{ n: number }>('SELECT COUNT(*) AS n FROM booking WHERE environment_id = ?', id);
  if (inUse && inUse.n > 0) {
    throw bad(`This environment has ${inUse.n} booking${inUse.n === 1 ? '' : 's'}. Remove them first.`);
  }
  const tasks = get<{ n: number }>('SELECT COUNT(*) AS n FROM task WHERE environment_id = ?', id);
  if (tasks && tasks.n > 0) {
    throw bad(`${tasks.n} task${tasks.n === 1 ? ' is' : 's are'} planned on this environment. Move ${tasks.n === 1 ? 'it' : 'them'} first.`);
  }
  run('DELETE FROM environment WHERE id = ?', id);
  res.status(204).end();
}));

// ---------------------------------------------------------------- projects

router.post('/projects', handle((req, res) => {
  const teamId = intParam(req.body?.team_id);
  if (teamId == null || !get('SELECT id FROM team WHERE id = ?', teamId)) throw bad('A valid team is required');

  const name = nonEmpty(req.body?.name, 'Project name');
  const parentId = intParam(req.body?.parent_id) ?? null;

  if (parentId != null) {
    const parent = get<Project>('SELECT * FROM project WHERE id = ?', parentId);
    if (!parent) throw bad('Parent project not found');
    // Depth is capped at one level per the requirements; enforce it here rather
    // than trusting the UI, since the API is the only other way data arrives.
    if (parent.parent_id != null) throw bad('Projects nest one level deep only');
    if (parent.team_id !== teamId) throw bad('A sub-project must belong to its parent\'s team');
  }

  const { lastInsertRowid } = run(
    `INSERT INTO project (team_id, parent_id, name, status, priority, owner, description, external_link,
                          start_date, target_date)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    teamId, parentId, name,
    oneOf(req.body?.status, STATUSES, 'status', 'planned'),
    oneOf(req.body?.priority, PRIORITIES, 'priority', 'normal'),
    req.body?.owner ?? null, req.body?.description ?? null, req.body?.external_link ?? null,
    optionalDate(req.body?.start_date, 'start_date'), optionalDate(req.body?.target_date, 'target_date'),
  );
  res.status(201).json(get('SELECT * FROM project WHERE id = ?', Number(lastInsertRowid)));
}));

router.patch('/projects/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<Project>('SELECT * FROM project WHERE id = ?', id);
  if (!existing) throw missing('Project');

  const next = {
    name: req.body?.name != null ? nonEmpty(req.body.name, 'Project name') : existing.name,
    status: req.body?.status != null ? oneOf(req.body.status, STATUSES, 'status') : existing.status,
    priority: req.body?.priority != null ? oneOf(req.body.priority, PRIORITIES, 'priority') : existing.priority,
    owner: req.body?.owner !== undefined ? req.body.owner : existing.owner,
    description: req.body?.description !== undefined ? req.body.description : existing.description,
    external_link: req.body?.external_link !== undefined ? req.body.external_link : existing.external_link,
    start_date: req.body?.start_date !== undefined ? optionalDate(req.body.start_date, 'start_date') : existing.start_date ?? null,
    target_date: req.body?.target_date !== undefined ? optionalDate(req.body.target_date, 'target_date') : existing.target_date ?? null,
    currency: req.body?.currency !== undefined ? currencyParam(req.body.currency) : existing.currency ?? 'EUR',
  };

  transaction(() => {
    run(
      `UPDATE project SET name = ?, status = ?, priority = ?, owner = ?, description = ?, external_link = ?,
                          start_date = ?, target_date = ?, currency = ? WHERE id = ?`,
      next.name, next.status, next.priority, next.owner, next.description, next.external_link,
      next.start_date, next.target_date, next.currency, id,
    );
    // Moving the start moves every task that is not pinned by a predecessor or its actual dates.
    if (next.start_date !== (existing.start_date ?? null)) {
      audit('project', id, 'start_date', existing.start_date, next.start_date);
      replanWithDownstream(id);
    }
  });
  res.json(get('SELECT * FROM project WHERE id = ?', id));
}));

/** An ISO 4217 code, three capital letters. Display only: amounts are never converted. */
function currencyParam(raw: unknown): string {
  const c = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(c)) throw bad('A currency is a three-letter code, like EUR or USD');
  return c;
}

router.delete('/projects/:id', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  run('DELETE FROM project WHERE id = ?', id);
  res.status(204).end();
}));

// ---------------------------------------------------------------- bookings

/**
 * Bookings start and end on working days. Callers get the snapped dates back
 * rather than an error, so a date picked on a Saturday lands on Monday instead
 * of bouncing the whole edit.
 */
function snapRange(start: ISODate, end: ISODate) {
  const holidays = holidaySet();
  const snappedStart = snapToWorkingDay(start, holidays, 1);
  let snappedEnd = snapToWorkingDay(end, holidays, -1);
  // A booking snapped past its own end collapses to a single day rather than inverting.
  if (snappedEnd < snappedStart) snappedEnd = snappedStart;
  return { start: snappedStart, end: snappedEnd, adjusted: snappedStart !== start || snappedEnd !== end };
}

const NOTE_MAX = 2000;

const TIMELINE_TEXT_MAX = 200;

/** Blank timeline text means the default; one line only, since it sits on a bar. */
function timelineTextValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw bad('timeline_text must be text');
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length > TIMELINE_TEXT_MAX) throw bad(`Timeline text can be at most ${TIMELINE_TEXT_MAX} characters`);
  return flat || null;
}

/** A blank note is no note: store null rather than an empty string. */
function noteValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value !== 'string') throw bad('note must be text');
  const trimmed = value.trim();
  if (trimmed.length > NOTE_MAX) throw bad(`A note can be at most ${NOTE_MAX} characters`);
  return trimmed || null;
}

/** Markers belong to CUSTOM bookings only; any other kind drops one rather than erroring. */
function markerValue(value: unknown, kind: BookingKind): Marker | null {
  if (kind !== 'CUSTOM' || value == null || value === '') return null;
  return oneOf(value, MARKERS, 'marker');
}

router.post('/bookings', handle((req, res) => {
  const projectId = intParam(req.body?.project_id);
  const project = projectId != null ? get<Project>('SELECT * FROM project WHERE id = ?', projectId) : undefined;
  if (!project) throw bad('A valid project is required');

  const envId = intParam(req.body?.environment_id);
  const env = envId != null ? get<Environment>('SELECT * FROM environment WHERE id = ?', envId) : undefined;
  if (!env) throw bad('A valid environment is required');
  if (env.team_id !== project.team_id) throw bad('That environment belongs to another team');

  const requestedKind = oneOf(req.body?.kind, BOOKING_KINDS, 'kind', 'CUSTOM');
  const rawStart = requireDate(req.body?.start_date, 'start_date');
  // A release is a single day; accept just a start date for it.
  const rawEnd = requestedKind === 'RELEASE' ? rawStart : requireDate(req.body?.end_date ?? req.body?.start_date, 'end_date');
  if (rawEnd < rawStart) throw bad('A booking cannot end before it starts');

  const { start, end, adjusted } = snapRange(rawStart, rawEnd);
  const kind = effectiveKind(requestedKind, start, end);
  const id = transaction(() => {
    const { lastInsertRowid } = run(
      `INSERT INTO booking (project_id, environment_id, kind, start_date, end_date, confidence, optional, note, marker,
                            timeline_text, manual_start, manual_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      projectId, envId, kind, start, end,
      oneOf(req.body?.confidence, CONFIDENCES, 'confidence', 'committed'),
      req.body?.optional ? 1 : 0,
      noteValue(req.body?.note),
      markerValue(req.body?.marker, kind),
      timelineTextValue(req.body?.timeline_text),
      start, end,
    );
    // A new manual booking may take over a hold that an auto booking was serving.
    replanWithDownstream(projectId!);
    return Number(lastInsertRowid);
  });

  res.status(201).json({ ...get('SELECT * FROM booking WHERE id = ?', id), adjusted });
}));

router.patch('/bookings/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<Booking>('SELECT * FROM booking WHERE id = ?', id);
  if (!existing) throw missing('Booking');

  let envId = existing.environment_id;
  if (req.body?.environment_id != null) {
    const candidate = intParam(req.body.environment_id);
    const env = candidate != null ? get<Environment>('SELECT * FROM environment WHERE id = ?', candidate) : undefined;
    if (!env) throw bad('A valid environment is required');
    const project = get<Project>('SELECT * FROM project WHERE id = ?', existing.project_id);
    if (project && env.team_id !== project.team_id) throw bad('That environment belongs to another team');
    envId = candidate!;
  }

  // Dates in a PATCH are the manual span; the stored span is that stretched over any
  // task hold. Setting dates or moving environment on a task-made booking makes it
  // manual: someone has now booked it by hand.
  const auto = existing.manual_start == null || existing.manual_end == null;
  const datesGiven = req.body?.start_date != null || req.body?.end_date != null || envId !== existing.environment_id;
  const baseStart = existing.manual_start ?? existing.start_date;
  const baseEnd = existing.manual_end ?? existing.end_date;
  const requestedKind = req.body?.kind != null ? oneOf(req.body.kind, BOOKING_KINDS, 'kind') : existing.kind;
  const rawStart = req.body?.start_date != null ? requireDate(req.body.start_date, 'start_date') : baseStart;
  const rawEnd = requestedKind === 'RELEASE'
    ? rawStart
    : (req.body?.end_date != null ? requireDate(req.body.end_date, 'end_date') : baseEnd);
  if (rawEnd < rawStart) throw bad('A booking cannot end before it starts');

  const { start, end, adjusted } = snapRange(rawStart, rawEnd);
  const kind = effectiveKind(requestedKind, start, end);
  const confidence = req.body?.confidence != null ? oneOf(req.body.confidence, CONFIDENCES, 'confidence') : existing.confidence;
  const optional = req.body?.optional != null ? (req.body.optional ? 1 : 0) : existing.optional;
  // undefined leaves a field alone; null clears it.
  const note = req.body?.note !== undefined ? noteValue(req.body.note) : existing.note;
  const timelineText = req.body?.timeline_text !== undefined
    ? timelineTextValue(req.body.timeline_text)
    : (existing.timeline_text ?? null);
  const marker = markerValue(req.body?.marker !== undefined ? req.body.marker : existing.marker, kind);

  const manualStart = auto && !datesGiven ? null : start;
  const manualEnd = auto && !datesGiven ? null : end;

  transaction(() => {
    // Dates are what people argue about, so every change to one is recorded.
    if (manualStart !== existing.manual_start) audit('booking', id, 'manual_start', existing.manual_start, manualStart);
    if (manualEnd !== existing.manual_end) audit('booking', id, 'manual_end', existing.manual_end, manualEnd);
    if (envId !== existing.environment_id) audit('booking', id, 'environment_id', existing.environment_id, envId);

    run(
      `UPDATE booking SET environment_id = ?, kind = ?, start_date = ?, end_date = ?, confidence = ?, optional = ?,
                          note = ?, marker = ?, timeline_text = ?, manual_start = ?, manual_end = ?
        WHERE id = ?`,
      envId, kind, auto && !datesGiven ? existing.start_date : start, auto && !datesGiven ? existing.end_date : end,
      confidence, optional, note, marker, timelineText, manualStart, manualEnd, id,
    );
    replanWithDownstream(existing.project_id);
  });
  res.json({ ...get('SELECT * FROM booking WHERE id = ?', id), adjusted });
}));

router.delete('/bookings/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<Booking>('SELECT * FROM booking WHERE id = ?', id);
  if (!existing) throw missing('Booking');
  if (existing.manual_start == null && existing.hold_start) {
    // Its tasks would book it straight back; say which ones instead.
    const names = all<{ name: string }>(
      `SELECT name FROM task WHERE project_id = ? AND environment_id = ? AND duration > 0
          AND start_date <= ? AND end_date >= ? ORDER BY start_date`,
      existing.project_id, existing.environment_id, existing.hold_end, existing.hold_start,
    ).map((t) => t.name);
    throw bad(`This booking is made by tasks${names.length ? ` (${names.join(', ')})` : ''}. Move or delete them in the plan.`);
  }
  transaction(() => {
    run('DELETE FROM booking WHERE id = ?', id);
    // Tasks it covered now need an auto booking of their own.
    replanWithDownstream(existing.project_id);
  });
  res.status(204).end();
}));

/** Hand an environment back once every task in the booking is done: trim the manual end to the last task. */
router.post('/bookings/:id/release', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<Booking>('SELECT * FROM booking WHERE id = ?', id);
  if (!existing) throw missing('Booking');
  if (!existing.hold_end || !existing.hold_done || existing.end_date <= existing.hold_end) {
    throw bad('Only a booking whose tasks are all done, and that runs on past them, can be released');
  }
  const previousEnd = existing.manual_end ?? existing.end_date;
  transaction(() => {
    const start = existing.manual_start && existing.manual_start < existing.hold_end! ? existing.manual_start : existing.hold_start;
    audit('booking', id, 'manual_end', previousEnd, existing.hold_end);
    run('UPDATE booking SET manual_start = ?, manual_end = ? WHERE id = ?', start, existing.hold_end, id);
    replanWithDownstream(existing.project_id);
  });
  res.json({ ...get('SELECT * FROM booking WHERE id = ?', id), previous_end: previousEnd });
}));

// ---------------------------------------------------------------- plans and tasks

function planResponse(projectId: number) {
  const state = loadState(projectId);
  const outcome = outcomeOf(state);
  if ('cycle' in outcome) throw bad('This plan has a dependency loop. Remove one of its links.');
  const holidays = holidaySet();
  const finish = state.tasks.length ? outcome.schedule.finish : null;
  return {
    project: get<Project>('SELECT * FROM project WHERE id = ?', projectId),
    tasks: listTasks(projectId),
    dependencies: state.deps,
    schedule: [...outcome.schedule.tasks.values()],
    critical_path: outcome.schedule.critical_path,
    order: outcome.schedule.order,
    finish,
    late_by: lateBy(finish, state.project.target_date, holidays),
    holds: outcome.holds,
    bookings: listBookings({ teamId: state.project.team_id }).filter((b) => b.project_id === projectId),
    // The baseline it compares with, and every saved one for the picker.
    baseline: [...compareBaseline(projectId)].map(([task_id, b]) => ({ task_id, start_date: b.start, end_date: b.end, duration: b.duration })),
    baselines: listBaselines(projectId),
    // Everyone, not only this plan's people: the Who column suggests from all of them.
    resources: listResources(),
    // Their work in other plans, so a person on two tasks at once is warned about here.
    elsewhere: workElsewhere(projectId),
    // Links to and from other plans (reqs/pm_features.md §7), the floors they set now,
    // for the chart's drag preview, and the team's plans, for After's tags.
    external: externalLinksOf(projectId),
    external_floors: [...(state.external ?? new Map())],
    link_projects: all<{ id: number; name: string }>('SELECT id, name FROM project WHERE team_id = ? ORDER BY name', state.project.team_id),
  };
}

router.get('/projects/:id/plan', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  res.json(planResponse(id));
}));

const TASK_NAME_MAX = 200;

/** Validate the task fields a request sets; absent fields are left out, not defaulted. */
function taskFields(body: Record<string, unknown> | undefined, teamId: number): TaskFields {
  const f: TaskFields = {};
  if (!body) return f;
  if (body.name !== undefined) {
    f.name = nonEmpty(body.name, 'Task name').replace(/\s+/g, ' ');
    if (f.name.length > TASK_NAME_MAX) throw bad(`A task name can be at most ${TASK_NAME_MAX} characters`);
  }
  if (body.environment_id !== undefined) {
    if (body.environment_id == null || body.environment_id === '') f.environment_id = null;
    else {
      const envId = intParam(body.environment_id);
      const env = envId != null ? get<Environment>('SELECT * FROM environment WHERE id = ?', envId) : undefined;
      if (!env) throw bad('A valid environment is required');
      if (env.team_id !== teamId) throw bad('That environment belongs to another team');
      f.environment_id = envId!;
    }
  }
  if (body.duration !== undefined) {
    const d = intParam(body.duration);
    if (d == null || d < 0 || d > 1000) throw bad('Duration is a whole number of working days, 0 to 1000');
    f.duration = d;
  }
  if (body.status !== undefined) f.status = oneOf(body.status, TASK_STATUSES, 'status');
  if (body.not_before !== undefined) f.not_before = optionalDate(body.not_before, 'not_before');
  if (body.deadline !== undefined) f.deadline = optionalDate(body.deadline, 'deadline');
  if (body.actual_start !== undefined) f.actual_start = optionalDate(body.actual_start, 'actual_start');
  if (body.actual_end !== undefined) f.actual_end = optionalDate(body.actual_end, 'actual_end');
  if (body.note !== undefined) f.note = noteValue(body.note);
  if (body.parent_id !== undefined) {
    // Which project it belongs to is checked with the rest of the outline (checkOutline).
    if (body.parent_id == null || body.parent_id === '') f.parent_id = null;
    else {
      const pid = intParam(body.parent_id);
      if (pid == null) throw bad('parent_id must be a task id');
      f.parent_id = pid;
    }
  }
  if (body.progress !== undefined) {
    if (body.progress == null || body.progress === '') f.progress = null;
    else {
      const n = intParam(body.progress);
      if (n == null || n < 0 || n > 100) throw bad('Progress is a whole percentage, 0 to 100');
      f.progress = n;
    }
  }
  if (body.code !== undefined) {
    const n = intParam(body.code);
    if (n == null || n < 1 || n > TASK_CODE_MAX) throw bad(`An ID is a whole number, 1 to ${TASK_CODE_MAX}`);
    f.code = n;
  }
  if (body.predecessors !== undefined) {
    if (!Array.isArray(body.predecessors)) throw bad('predecessors must be a list');
    f.predecessors = body.predecessors.map((p) => {
      const id = intParam((p as { id?: unknown })?.id);
      const lag = intParam((p as { lag?: unknown })?.lag ?? 0);
      if (id == null || lag == null) throw bad('Each predecessor needs a task id and a whole-day lag');
      const type = oneOf((p as { type?: unknown })?.type ?? 'FS', LINK_TYPES, 'link type');
      return { id, lag, type };
    });
  }
  if (f.actual_start && f.actual_end && f.actual_end < f.actual_start) throw bad('A task cannot finish before it starts');
  return f;
}

/**
 * The people a request puts on a task, as names; undefined when it leaves them
 * alone. Takes the Who text or a list of names, split by the same rule either way.
 */
function resourcesFrom(body: Record<string, unknown> | undefined): string[] | undefined {
  const raw = body?.resources;
  if (raw === undefined) return undefined;
  if (raw !== null && typeof raw !== 'string' && !Array.isArray(raw)) throw bad('resources must be text or a list of names');
  const parsed = parseResources(Array.isArray(raw) ? raw.map((n) => String(n ?? '').replace(/[,;]/g, ' ')).join(',') : raw);
  if (!parsed.ok) throw bad(parsed.error);
  return parsed.names;
}

/** Put these people on a task, making any not seen before, and log the change. Call inside a transaction. */
function assign(taskId: number, names: string[]) {
  const byId = new Map(all<{ id: number; name: string }>('SELECT id, name FROM resource').map((r) => [r.id, r]));
  const old = all<{ resource_id: number }>('SELECT resource_id FROM task_resource WHERE task_id = ? ORDER BY sort_order', taskId)
    .map((r) => r.resource_id);
  const ids = ensureResources(names);
  if (ids.join(',') === old.join(',')) return;
  setTaskResources(taskId, ids);
  for (const r of all<{ id: number; name: string }>('SELECT id, name FROM resource')) byId.set(r.id, r);
  audit('task', taskId, 'resources', formatResources(old, byId) || null, formatResources(ids, byId) || null);
}

function taskProject(taskId: number): Project {
  const p = get<Project>('SELECT p.* FROM project p JOIN task t ON t.project_id = p.id WHERE t.id = ?', taskId);
  if (!p) throw missing('Task');
  return p;
}

/**
 * A task's best and worst case from a request; undefined when it leaves them
 * alone. Checked against the duration in `setEstimate`, once the change is in.
 */
function estimateFrom(body: Record<string, unknown> | undefined): Estimate | undefined {
  if (!body || (body.duration_low === undefined && body.duration_high === undefined)) return undefined;
  const out: Estimate = {};
  for (const k of ['duration_low', 'duration_high'] as const) {
    if (body[k] === undefined) continue;
    if (body[k] == null || body[k] === '') { out[k] = null; continue; }
    const n = intParam(body[k]);
    if (n == null || n < 0 || n > ESTIMATE_MAX) throw bad(`${k === 'duration_low' ? 'Best' : 'Worst'} is a whole number of working days, 0 to ${ESTIMATE_MAX}`);
    out[k] = n;
  }
  return out;
}

/** Set a task's best and worst case. A summary has none: its range is its tasks'. Call inside a transaction. */
function setEstimate(taskId: number, est: Estimate) {
  const t = get<Task>('SELECT * FROM task WHERE id = ?', taskId)!;
  if (get('SELECT id FROM task WHERE parent_id = ? LIMIT 1', taskId) && (est.duration_low != null || est.duration_high != null)) {
    throw bad(`${t.name} is a summary: its best and worst case come from the tasks under it`);
  }
  const low = est.duration_low !== undefined ? est.duration_low : t.duration_low ?? null;
  const high = est.duration_high !== undefined ? est.duration_high : t.duration_high ?? null;
  const error = estimateError(t.duration, low, high);
  if (error) throw bad(error);
  if (low === (t.duration_low ?? null) && high === (t.duration_high ?? null)) return;
  if (low !== (t.duration_low ?? null)) audit('task', taskId, 'duration_low', t.duration_low ?? null, low);
  if (high !== (t.duration_high ?? null)) audit('task', taskId, 'duration_high', t.duration_high ?? null, high);
  run('UPDATE task SET duration_low = ?, duration_high = ? WHERE id = ?', low, high, taskId);
}

/** A task's fixed and actual cost from a request; undefined when it leaves them alone. */
type Cost = { fixed_cost?: number | null; actual_cost?: number | null };
export const MONEY_MAX = 1e12;

function moneyParam(raw: unknown, what: string): number | null {
  if (raw == null || raw === '') return null;
  const n = typeof raw === 'number' ? raw : Number(String(raw).replace(/[,\s]/g, ''));
  if (!Number.isFinite(n) || n < 0 || n > MONEY_MAX) throw bad(`${what} is an amount of 0 or more`);
  return Math.round(n * 100) / 100;
}

function costFrom(body: Record<string, unknown> | undefined): Cost | undefined {
  if (!body || (body.fixed_cost === undefined && body.actual_cost === undefined)) return undefined;
  const out: Cost = {};
  if (body.fixed_cost !== undefined) out.fixed_cost = moneyParam(body.fixed_cost, 'Fixed cost');
  if (body.actual_cost !== undefined) out.actual_cost = moneyParam(body.actual_cost, 'Actual cost');
  return out;
}

/** Set a task's fixed and actual cost. A summary has none: its cost is its tasks'. Call inside a transaction. */
function setCost(taskId: number, c: Cost) {
  const t = get<Task>('SELECT * FROM task WHERE id = ?', taskId)!;
  if (get('SELECT id FROM task WHERE parent_id = ? LIMIT 1', taskId) && (c.fixed_cost != null || c.actual_cost != null)) {
    throw bad(`${t.name} is a summary: its cost comes from the tasks under it`);
  }
  for (const k of ['fixed_cost', 'actual_cost'] as const) {
    if (c[k] === undefined || c[k] === (t[k] ?? null)) continue;
    audit('task', taskId, k, t[k] ?? null, c[k]);
    run(`UPDATE task SET ${k} = ? WHERE id = ?`, c[k], taskId);
  }
}

/** What a task request carries besides plan fields: people, estimates and cost, none of which is plan state. */
type Extras = { who?: string[]; estimate?: Estimate; cost?: Cost };

function extrasFrom(body: Record<string, unknown> | undefined): Extras {
  return { who: resourcesFrom(body), estimate: estimateFrom(body), cost: costFrom(body) };
}

/**
 * Apply a change and replan, all or nothing. Returns the created task id for a
 * create. `extras` puts people and estimates on the task in the same
 * transaction; neither is plan state, so an update that changes only them skips
 * the replan and cannot move a date.
 */
function commit(projectId: number, change: Change, extras: Extras = {}): number | null {
  const { who, estimate, cost } = extras;
  return transaction(() => {
    if (change.op === 'update' && (who || estimate || cost) && !Object.keys(change.fields).length) {
      if (who) assign(change.id, who);
      if (estimate) setEstimate(change.id, estimate);
      if (cost) setCost(change.id, cost);
      return null;
    }
    const before = loadState(projectId);
    const downstream = downstreamProjects(projectId);
    const created = writeState(before, applyChange(before, change));
    replanWithDownstream(projectId, downstream);
    const taskId = change.op === 'create' ? created : change.op === 'update' ? change.id : null;
    if (who && taskId != null) assign(taskId, who);
    if (estimate && taskId != null) setEstimate(taskId, estimate);
    if (cost && taskId != null) setCost(taskId, cost);
    return created;
  });
}

function changeFrom(req: Request, projectId: number): Change {
  const body = req.body ?? {};
  const change = body.change ?? body;
  const project = get<Project>('SELECT * FROM project WHERE id = ?', projectId)!;
  if (change.op === 'create') {
    return { op: 'create', fields: { name: 'New task', ...taskFields(change.fields, project.team_id) } as TaskFields & { name: string }, after_id: intParam(change.after_id) ?? null };
  }
  if (change.op === 'outline') return { op: 'outline', placements: placementsFrom(change.placements, projectId) };
  const id = intParam(change.id);
  if (id == null) throw bad('A task id is required');
  if (taskProject(id).id !== projectId) throw bad('That task belongs to another project');
  if (change.op === 'update') return { op: 'update', id, fields: taskFields(change.fields, project.team_id) };
  if (change.op === 'delete') return { op: 'delete', id, bridge: Boolean(change.bridge), children: childrenMode(change.children) };
  throw bad('op must be create, update, delete or outline');
}

/** What happens to a deleted summary's tasks: they go with it, or move up a level (the default). */
function childrenMode(raw: unknown): 'lift' | 'delete' {
  if (raw == null || raw === '' || raw === 'lift') return 'lift';
  if (raw === 'delete') return 'delete';
  throw bad('children must be lift or delete');
}

router.post('/tasks', handle((req, res) => {
  const projectId = intParam(req.body?.project_id);
  const project = projectId != null ? get<Project>('SELECT * FROM project WHERE id = ?', projectId) : undefined;
  if (!project) throw bad('A valid project is required');
  const fields = taskFields(req.body, project.team_id);
  if (!fields.name) throw bad('Task name is required');
  const id = commit(project.id, { op: 'create', fields: fields as TaskFields & { name: string }, after_id: intParam(req.body?.after_id) ?? null },
    extrasFrom(req.body));
  res.status(201).json({ id, plan: planResponse(project.id) });
}));

router.patch('/tasks/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const project = taskProject(id);
  commit(project.id, { op: 'update', id, fields: taskFields(req.body, project.team_id) }, extrasFrom(req.body));
  res.json({ id, plan: planResponse(project.id) });
}));

router.delete('/tasks/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const project = taskProject(id);
  commit(project.id, { op: 'delete', id, bridge: req.query.bridge === '1', children: childrenMode(req.query.children) });
  res.json({ plan: planResponse(project.id) });
}));

/** New parents and sibling orders for some of one project's tasks. */
function placementsFrom(raw: unknown, projectId: number) {
  if (!Array.isArray(raw) || !raw.length) throw bad('placements must be a non-empty list');
  const own = new Set(listTasks(projectId).map((t) => t.id));
  return raw.map((p) => {
    const id = intParam(p?.id);
    const parent = p?.parent_id == null ? null : intParam(p.parent_id);
    const order = intParam(p?.sort_order);
    if (id == null || !own.has(id)) throw bad('Every placement must be a task of this project');
    if (parent === undefined || (parent != null && !own.has(parent))) throw bad('A summary must be a task of this project');
    if (order == null) throw bad('Each placement needs a sort_order');
    return { id, parent_id: parent, sort_order: order };
  });
}

/** Indent, outdent or move rows in the outline. Links to a summary hold its tasks, so this can move dates. */
router.post('/tasks/outline', handle((req, res) => {
  const projectId = intParam(req.body?.project_id);
  if (projectId == null || !get('SELECT id FROM project WHERE id = ?', projectId)) throw bad('A valid project is required');
  commit(projectId, { op: 'outline', placements: placementsFrom(req.body?.placements, projectId) });
  res.json({ plan: planResponse(projectId) });
}));

// ---------------------------------------------------------------- baselines

/** A project's saved baselines, oldest first; with `?tasks=1`, each one's tasks too (for MS Project files). */
router.get('/projects/:id/baselines', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  const list = listBaselines(id);
  res.json(req.query.tasks ? list.map((b) => ({ ...b, rows: baselineTasks(b.id) })) : list);
}));

function baselineName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw bad('A baseline needs a name');
  if (name.length > BASELINE_NAME_MAX) throw bad(`A baseline name is at most ${BASELINE_NAME_MAX} characters`);
  return name;
}

/**
 * Save every task's dates and length as a new named baseline. The first one
 * becomes the one the plan compares with; later ones do not change it.
 */
router.post('/projects/:id/baselines', handle((req, res) => {
  const id = Number(req.params.id);
  const project = get<Project>('SELECT * FROM project WHERE id = ?', id);
  if (!project) throw missing('Project');
  const name = baselineName(req.body?.name);
  transaction(() => {
    const list = listBaselines(id);
    if (list.length >= BASELINES_MAX) {
      throw bad(`A plan keeps at most ${BASELINES_MAX} baselines. Delete one first; the oldest is “${list[0].name}”.`);
    }
    if (list.some((b) => b.name.toLowerCase() === name.toLowerCase())) throw bad(`There is already a baseline called “${name}”`);
    const finish = get<{ f: ISODate | null }>('SELECT MAX(end_date) AS f FROM task WHERE project_id = ?', id)!.f;
    const baselineId = Number(run('INSERT INTO baseline (project_id, name, finish) VALUES (?, ?, ?)', id, name, finish).lastInsertRowid);
    run(`INSERT INTO task_baseline (baseline_id, task_id, project_id, start_date, end_date, duration)
         SELECT ?, id, project_id, start_date, end_date, duration FROM task
         WHERE project_id = ? AND start_date IS NOT NULL AND end_date IS NOT NULL`, baselineId, id);
    // Each task's planned cost as it stands: the budget earned value measures against.
    for (const [taskId, cost] of plannedCosts(id)) {
      if (cost != null) run('UPDATE task_baseline SET cost = ? WHERE baseline_id = ? AND task_id = ?', cost, baselineId, taskId);
    }
    if (project.compare_baseline_id == null) run('UPDATE project SET compare_baseline_id = ? WHERE id = ?', baselineId, id);
    audit('project', id, 'baseline', null, name);
  });
  res.json({ plan: planResponse(id) });
}));

function baselineOf(req: Request) {
  const b = get<{ id: number; project_id: number; name: string }>('SELECT id, project_id, name FROM baseline WHERE id = ?', Number(req.params.id));
  if (!b) throw missing('Baseline');
  return b;
}

/** Rename a baseline, or make it the one the plan compares with (`compare: true`). */
router.patch('/baselines/:id', handle((req, res) => {
  const b = baselineOf(req);
  transaction(() => {
    if (req.body?.name !== undefined) {
      const name = baselineName(req.body.name);
      const clash = get('SELECT id FROM baseline WHERE project_id = ? AND lower(name) = lower(?) AND id <> ?', b.project_id, name, b.id);
      if (clash) throw bad(`There is already a baseline called “${name}”`);
      if (name !== b.name) {
        run('UPDATE baseline SET name = ? WHERE id = ?', name, b.id);
        audit('baseline', b.id, 'name', b.name, name);
      }
    }
    if (req.body?.compare === true) run('UPDATE project SET compare_baseline_id = ? WHERE id = ?', b.id, b.project_id);
  });
  res.json({ plan: planResponse(b.project_id) });
}));

/** Delete a baseline. If the plan compared with it, it compares with the newest one left. */
router.delete('/baselines/:id', handle((req, res) => {
  const b = baselineOf(req);
  transaction(() => {
    const comparing = get<{ c: number | null }>('SELECT compare_baseline_id AS c FROM project WHERE id = ?', b.project_id)!.c === b.id;
    run('DELETE FROM baseline WHERE id = ?', b.id);
    if (comparing) {
      const newest = get<{ id: number }>('SELECT id FROM baseline WHERE project_id = ? ORDER BY saved_at DESC, id DESC LIMIT 1', b.project_id);
      run('UPDATE project SET compare_baseline_id = ? WHERE id = ?', newest?.id ?? null, b.project_id);
    }
    audit('project', b.project_id, 'baseline', b.name, null);
  });
  res.json({ plan: planResponse(b.project_id) });
}));

// ---------------------------------------------------------------- earned value

/** Earned value at a status date (today by default), against the baseline the plan compares with. */
router.get('/projects/:id/earned-value', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  res.json(projectEarnedValue(id, req.query.date == null ? undefined : requireDate(req.query.date, 'date')));
}));

// ---------------------------------------------------------------- import

const IMPORT_MAX = 2000;

/** A file row's people: `resources` as the Who text or names, or `assignee` from older callers. */
function resourcesOfRow(r: Record<string, unknown>, at: string): string[] {
  try {
    return resourcesFrom({ resources: r.resources ?? r.assignee ?? null }) ?? [];
  } catch (err) {
    throw bad(`${at}: ${(err as Error).message}`);
  }
}

/**
 * Append tasks from a file (CSV or MS Project XML, parsed in the browser). Rows
 * refer to each other by their 1-based position in the import: `parent` names a
 * row above, `predecessors` rows anywhere. All or nothing, and one replan.
 */
router.post('/projects/:id/import', handle((req, res) => {
  const projectId = Number(req.params.id);
  const project = get<Project>('SELECT * FROM project WHERE id = ?', projectId);
  if (!project) throw missing('Project');
  const rows: unknown[] = Array.isArray(req.body?.rows) ? req.body.rows : [];
  if (!rows.length) throw bad('There is nothing to import');
  if (rows.length > IMPORT_MAX) throw bad(`Import at most ${IMPORT_MAX} tasks at once`);

  const envs = listEnvironments(project.team_id);
  const warnings: string[] = [];
  const parsed = rows.map((raw, i) => {
    const r = raw as Record<string, unknown>;
    const at = `Row ${i + 1}`;
    const name = typeof r.name === 'string' ? r.name.trim().replace(/\s+/g, ' ') : '';
    if (!name) throw bad(`${at} has no task name`);
    if (name.length > TASK_NAME_MAX) throw bad(`${at}: a task name can be at most ${TASK_NAME_MAX} characters`);
    const duration = r.duration == null || r.duration === '' ? 1 : intParam(r.duration);
    if (duration == null || duration < 0 || duration > 1000) throw bad(`${at}: duration is a whole number of working days, 0 to 1000`);
    let environment_id: number | null = null;
    if (typeof r.environment === 'string' && r.environment.trim()) {
      const env = envs.find((e) => e.name.toLowerCase() === (r.environment as string).trim().toLowerCase());
      if (env) environment_id = env.id;
      else warnings.push(`${at}: no environment called “${r.environment}”, so it books nothing`);
    }
    const parent = r.parent == null || r.parent === '' ? null : intParam(r.parent);
    if (parent !== null && (parent == null || parent < 1 || parent >= i + 1)) throw bad(`${at}: its summary must be a row above it`);
    const preds = Array.isArray(r.predecessors) ? r.predecessors : [];
    const predecessors = preds.map((p) => {
      const row = intParam((p as { row?: unknown })?.row);
      const lag = intParam((p as { lag?: unknown })?.lag ?? 0);
      if (row == null || row < 1 || row > rows.length || row === i + 1 || lag == null) throw bad(`${at}: a predecessor must be another row of the import`);
      return { row, lag, type: oneOf((p as { type?: unknown })?.type ?? 'FS', LINK_TYPES, 'link type') };
    });
    const progress = r.progress == null || r.progress === '' ? null : intParam(r.progress);
    if (progress !== null && (progress == null || progress < 0 || progress > 100)) throw bad(`${at}: progress is 0 to 100`);
    let estimate: Estimate;
    try {
      estimate = estimateFrom({ duration_low: r.duration_low, duration_high: r.duration_high }) ?? {};
    } catch (err) { throw bad(`${at}: ${(err as Error).message}`); }
    const estError = estimateError(duration, estimate.duration_low, estimate.duration_high);
    if (estError) throw bad(`${at}: ${estError}`);
    // The file's own ID is kept when it is free; otherwise the task gets the next one.
    const code = intParam(r.code);
    return {
      name, duration, environment_id, parent, predecessors, progress,
      duration_low: estimate.duration_low ?? null, duration_high: estimate.duration_high ?? null,
      code: code != null && code >= 1 && code <= TASK_CODE_MAX ? code : null,
      status: r.status ? oneOf(r.status, TASK_STATUSES, 'status') : 'todo' as const,
      not_before: optionalDate(r.not_before, 'not_before'),
      deadline: optionalDate(r.deadline, 'deadline'),
      fixed_cost: moneyParam(r.fixed_cost, `${at}: fixed cost`),
      actual_cost: moneyParam(r.actual_cost, `${at}: actual cost`),
      resources: resourcesOfRow(r, at),
      note: noteValue(r.note),
      baselines: baselinesOfRow(r.baselines, at),
    };
  });

  transaction(() => {
    const base = get<{ n: number }>('SELECT COALESCE(MAX(sort_order), -1) + 1 AS n FROM task WHERE project_id = ?', projectId)!.n;
    const codes = all<{ code: number | null }>('SELECT code FROM task WHERE project_id = ?', projectId);
    const used = new Set(codes.map((c) => c.code));
    const given = parsed.map((t) => (t.code != null && !used.has(t.code) ? t.code : null));
    // Keep each free file ID once; the rest are numbered after everything taken.
    const claimed = new Set<number>();
    given.forEach((c, i) => { if (c != null && claimed.has(c)) given[i] = null; else if (c != null) claimed.add(c); });
    let next = codes.length + 1;
    const ids: number[] = [];
    parsed.forEach((t, i) => {
      let code = given[i];
      if (code == null) {
        while (used.has(next) || claimed.has(next)) next++;
        code = next++;
      }
      ids.push(Number(run(
        `INSERT INTO task (project_id, environment_id, name, duration, status, not_before, note, sort_order, parent_id, progress, code,
                           duration_low, duration_high, deadline, fixed_cost, actual_cost)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        projectId, t.environment_id, t.name, t.duration, t.status, t.not_before, t.note, base + i,
        t.parent != null ? ids[t.parent - 1] : null, t.progress, code, t.duration_low, t.duration_high, t.deadline,
        t.fixed_cost, t.actual_cost,
      ).lastInsertRowid));
    });
    parsed.forEach((t, i) => { if (t.resources.length) assign(ids[i], t.resources); });
    parsed.forEach((t, i) => {
      for (const p of t.predecessors) {
        run('INSERT OR IGNORE INTO task_dependency (predecessor_id, successor_id, lag, type) VALUES (?, ?, ?, ?)',
          ids[p.row - 1], ids[i], p.lag, p.type);
      }
    });
    importBaselines(projectId, parsed.map((t, i) => ({ id: ids[i], baselines: t.baselines })), warnings);
    // The same rules as a hand edit: summaries book nothing, links stay legal.
    const state = loadState(projectId);
    const checked = checkOutline(state.tasks, state.deps);
    for (const t of checked.tasks) if (t.environment_id == null) run('UPDATE task SET environment_id = NULL WHERE id = ?', t.id);
    replanWithDownstream(projectId);
  });
  res.status(201).json({ plan: planResponse(projectId), created: parsed.length, warnings });
}));

/** An import row's MS Project baselines, checked; a bad one is refused like any other field. */
function baselinesOfRow(raw: unknown, at: string): { number: number; start: ISODate; finish: ISODate; duration: number | null }[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 11) throw bad(`${at}: baselines must be a list of at most 11`);
  return raw.map((b) => {
    const o = (b ?? {}) as Record<string, unknown>;
    const number = intParam(o.number);
    const start = optionalDate(o.start, 'baseline start');
    const finish = optionalDate(o.finish, 'baseline finish');
    const duration = o.duration == null ? null : intParam(o.duration);
    if (number == null || number < 0 || number > 10 || !start || !finish || finish < start || duration === undefined || (duration != null && duration < 0)) {
      throw bad(`${at}: a baseline needs a number 0 to 10, a start and a finish`);
    }
    return { number, start, finish, duration };
  });
}

/**
 * Baselines from an MS Project file: number n joins the plan's baseline of that
 * name ("Baseline", "Baseline 1"…), or makes it while there is room. The first
 * one made becomes the one compared with when the plan had none.
 */
function importBaselines(projectId: number, rows: { id: number; baselines: ReturnType<typeof baselinesOfRow> }[], warnings: string[]) {
  const byNumber = new Map<number, { task: number; start: ISODate; finish: ISODate; duration: number | null }[]>();
  for (const r of rows) for (const b of r.baselines) {
    if (!byNumber.has(b.number)) byNumber.set(b.number, []);
    byNumber.get(b.number)!.push({ task: r.id, ...b });
  }
  for (const [number, list] of [...byNumber].sort((a, b) => a[0] - b[0])) {
    const name = number === 0 ? 'Baseline' : `Baseline ${number}`;
    const finish = list.reduce((m, x) => (x.finish > m ? x.finish : m), list[0].finish);
    let found = get<{ id: number; finish: ISODate | null }>('SELECT id, finish FROM baseline WHERE project_id = ? AND lower(name) = lower(?)', projectId, name);
    if (!found) {
      if (listBaselines(projectId).length >= BASELINES_MAX) {
        warnings.push(`${name} from the file was left out: a plan keeps at most ${BASELINES_MAX} baselines`);
        continue;
      }
      found = { id: Number(run('INSERT INTO baseline (project_id, name, finish) VALUES (?, ?, ?)', projectId, name, finish).lastInsertRowid), finish };
      run('UPDATE project SET compare_baseline_id = ? WHERE id = ? AND compare_baseline_id IS NULL', found.id, projectId);
    } else if (!found.finish || finish > found.finish) {
      run('UPDATE baseline SET finish = ? WHERE id = ?', finish, found.id);
    }
    for (const x of list) {
      run(`INSERT OR REPLACE INTO task_baseline (baseline_id, task_id, project_id, start_date, end_date, duration)
           VALUES (?, ?, ?, ?, ?, ?)`, found.id, x.task, projectId, x.start, x.finish, x.duration);
    }
  }
}

// ---------------------------------------------------------------- portfolio

/**
 * Every plan of a team at once, for the portfolio chart: each project's schedule
 * as it stands, computed like the plan page does, never written.
 */
router.get('/teams/:id/portfolio', handle((req, res) => {
  const teamId = Number(req.params.id);
  if (!get('SELECT id FROM team WHERE id = ?', teamId)) throw missing('Team');
  const holidays = holidaySet();
  const projects = all<Project>('SELECT * FROM project WHERE team_id = ? ORDER BY name', teamId).map((p) => {
    const state = loadState(p.id);
    const outcome = outcomeOf(state);
    if ('cycle' in outcome || !state.tasks.length) {
      return { project: p, tasks: [] as Task[], dependencies: [], schedule: [], finish: null, late_by: 0 };
    }
    const finish = outcome.schedule.finish;
    return {
      project: p,
      tasks: outcome.tasks,
      dependencies: state.deps.map(({ predecessor_id, successor_id, lag, type }) => ({ predecessor_id, successor_id, lag, type })),
      schedule: [...outcome.schedule.tasks.values()],
      finish,
      late_by: lateBy(finish, p.target_date, holidays),
    };
  });
  // Links between the team's plans, for the portfolio's arrows and its critical path across them.
  const links = all<{ id: number; predecessor_id: number; successor_id: number; type: LinkType; lag: number }>(
    `SELECT l.id, l.predecessor_id, l.successor_id, l.type, l.lag FROM project_link l
     JOIN task t ON t.id = l.predecessor_id JOIN project p ON p.id = t.project_id WHERE p.team_id = ?`, teamId,
  );
  res.json({ projects, links });
}));

// ---------------------------------------------------------------- links between projects

/** A plan's links to and from other projects' tasks, with the other side named. */
function externalLinksOf(projectId: number): { incoming: ExternalLink[]; outgoing: ExternalLink[] } {
  const select = (other: 'predecessor_id' | 'successor_id', own: 'predecessor_id' | 'successor_id') => all<ExternalLink>(
    `SELECT l.id, l.predecessor_id, l.successor_id, l.type, l.lag,
            o.id AS other_task_id, o.code AS other_code, o.name AS other_name, o.start_date AS other_start, o.end_date AS other_end,
            op.id AS project_id, op.name AS project_name
     FROM project_link l JOIN task me ON me.id = l.${own} JOIN task o ON o.id = l.${other} JOIN project op ON op.id = o.project_id
     WHERE me.project_id = ? ORDER BY op.name, o.code`, projectId,
  );
  return { incoming: select('predecessor_id', 'successor_id'), outgoing: select('successor_id', 'predecessor_id') };
}

/**
 * Set what a task waits on in other plans of its team: the whole list,
 * replacing what it had. Refused for a summary, a task in its own plan, another
 * team's task, and a loop between plans, naming it. Replans the task's plan and
 * every plan after it, in one transaction.
 */
router.put('/tasks/:id/external-links', handle((req, res) => {
  const id = Number(req.params.id);
  const project = taskProject(id);
  const raw = req.body?.links;
  if (!Array.isArray(raw) || raw.length > 50) throw bad('links must be a list of at most 50');
  if (get('SELECT id FROM task WHERE parent_id = ? LIMIT 1', id) && raw.length) {
    throw bad('A summary waits on nothing itself: link the tasks under it');
  }
  const links = raw.map((l) => {
    // A task by its id, or as After writes it: its plan and its TaskID.
    const o = (l ?? {}) as { task_id?: unknown; project_id?: unknown; code?: unknown };
    const predId = intParam(o.task_id) ?? (intParam(o.project_id) != null && intParam(o.code) != null
      ? get<{ id: number }>('SELECT id FROM task WHERE project_id = ? AND code = ?', intParam(o.project_id), intParam(o.code))?.id
      : undefined);
    const pred = predId != null ? get<Task & { team_id: number; project_name: string }>(
      'SELECT t.*, p.team_id, p.name AS project_name FROM task t JOIN project p ON p.id = t.project_id WHERE t.id = ?', predId,
    ) : undefined;
    if (!pred) {
      const p = intParam(o.project_id) != null ? get<{ name: string }>('SELECT name FROM project WHERE id = ?', intParam(o.project_id)) : undefined;
      throw bad(p ? `${p.name} has no task with ID ${o.code}` : 'Each link needs a task that exists');
    }
    if (pred.project_id === project.id) throw bad('That task is in this plan: write its ID alone in After');
    if (pred.team_id !== project.team_id) throw bad('Plans can only wait on plans of the same team');
    if (get('SELECT id FROM task WHERE parent_id = ? LIMIT 1', pred.id)) throw bad(`${pred.name} in ${pred.project_name} is a summary: link one of the tasks under it`);
    const lag = intParam((l as { lag?: unknown })?.lag ?? 0);
    if (lag == null || lag < -1000 || lag > 1000) throw bad('A lag is a whole number of working days');
    return { pred: pred.id, type: oneOf((l as { type?: unknown })?.type ?? 'FS', LINK_TYPES, 'link type'), lag };
  });
  transaction(() => {
    const before = all<{ predecessor_id: number; type: string; lag: number }>('SELECT predecessor_id, type, lag FROM project_link WHERE successor_id = ?', id);
    run('DELETE FROM project_link WHERE successor_id = ?', id);
    for (const l of links) {
      run('INSERT OR REPLACE INTO project_link (predecessor_id, successor_id, type, lag) VALUES (?, ?, ?, ?)', l.pred, id, l.type, l.lag);
    }
    const projects = all<{ id: number }>('SELECT id FROM project WHERE team_id = ?', project.team_id).map((p) => p.id);
    const order = projectOrder(projects, projectEdges(project.team_id));
    if ('cycle' in order) throw bad(`Plans would wait on each other in a loop: ${projectNames(order.cycle)}`);
    const show = (rows: readonly { predecessor_id: number; type: string; lag: number }[]) => rows.map((r) => `${r.predecessor_id}${r.type}${r.lag}`).sort().join(',') || null;
    audit('task', id, 'external_links', show(before), show(links.map((l) => ({ predecessor_id: l.pred, type: l.type, lag: l.lag }))));
    replanWithDownstream(project.id);
  });
  res.json({ plan: planResponse(project.id) });
}));

router.post('/tasks/reorder', handle((req, res) => {
  const projectId = intParam(req.body?.project_id);
  if (projectId == null || !get('SELECT id FROM project WHERE id = ?', projectId)) throw bad('A valid project is required');
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(intParam) : [];
  const current = listTasks(projectId).map((t) => t.id);
  if (ids.length !== current.length || ids.some((id: number | undefined) => id == null || !current.includes(id))) {
    throw bad('Reorder needs every task of the project exactly once');
  }
  transaction(() => ids.forEach((id: number, i: number) => run('UPDATE task SET sort_order = ? WHERE id = ?', i, id)));
  res.json({ plan: planResponse(projectId) });
}));

// ---------------------------------------------------------------- network layout
// Where boxes and arrows sit in the network diagram. Layout only: none of this is
// read by scheduling, so none of it replans.

const LAYOUT_MAX = 50_000;

function coordinate(value: unknown, field: string): number | null {
  if (value == null) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || Math.abs(n) > LAYOUT_MAX) throw bad(`${field} must be a number`);
  return Math.round(n * 10) / 10;
}

router.patch('/tasks/:id/position', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM task WHERE id = ?', id)) throw missing('Task');
  const x = coordinate(req.body?.x, 'x');
  const y = coordinate(req.body?.y, 'y');
  // Both or neither: half a position is no position.
  run('UPDATE task SET net_x = ?, net_y = ? WHERE id = ?', x != null && y != null ? Math.max(0, x) : null,
    x != null && y != null ? Math.max(0, y) : null, id);
  res.json({ id, net_x: x, net_y: y });
}));

function anchor(value: unknown, field: string): string | null {
  if (value == null) return null;
  if (value !== 'top' && value !== 'mid' && value !== 'bottom') throw bad(`${field} must be top, mid or bottom`);
  return value;
}

function writeRoute(pred: number, succ: number, body: Record<string, unknown> | undefined) {
  run(`UPDATE task_dependency SET route_out = ?, route_y = ?, route_in = ?, route_from = ?, route_to = ?
        WHERE predecessor_id = ? AND successor_id = ?`,
  coordinate(body?.out, 'out'), coordinate(body?.y, 'y'), coordinate(body?.in, 'in'),
  anchor(body?.from, 'from'), anchor(body?.to, 'to'), pred, succ);
}

router.patch('/dependencies/route', handle((req, res) => {
  const pred = intParam(req.body?.predecessor_id);
  const succ = intParam(req.body?.successor_id);
  if (pred == null || succ == null || !get('SELECT 1 FROM task_dependency WHERE predecessor_id = ? AND successor_id = ?', pred, succ)) {
    throw missing('Link');
  }
  writeRoute(pred, succ, req.body);
  res.json({ predecessor_id: pred, successor_id: succ });
}));

/**
 * A whole arrangement at once: Smart Arrange, and putting back what it replaced.
 * Every box and link listed is overwritten, nulls included; the rest are left alone.
 */
router.put('/projects/:id/layout', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  const tasks: unknown[] = Array.isArray(req.body?.tasks) ? req.body.tasks : [];
  const links: unknown[] = Array.isArray(req.body?.dependencies) ? req.body.dependencies : [];
  const own = new Set(all<{ id: number }>('SELECT id FROM task WHERE project_id = ?', id).map((t) => t.id));
  transaction(() => {
    for (const raw of tasks) {
      const t = raw as Record<string, unknown>;
      const taskId = intParam(t?.id);
      if (taskId == null || !own.has(taskId)) throw bad('Every task must belong to this project');
      const x = coordinate(t.x, 'x');
      const y = coordinate(t.y, 'y');
      const both = x != null && y != null;
      run('UPDATE task SET net_x = ?, net_y = ? WHERE id = ?', both ? Math.max(0, x) : null, both ? Math.max(0, y) : null, taskId);
    }
    for (const raw of links) {
      const l = raw as Record<string, unknown>;
      const pred = intParam(l?.predecessor_id);
      const succ = intParam(l?.successor_id);
      if (pred == null || succ == null || !own.has(succ)) throw bad('Every link must belong to this project');
      writeRoute(pred, succ, l);
    }
  });
  res.status(204).end();
}));

router.post('/projects/:id/layout/reset', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  transaction(() => {
    run('UPDATE task SET net_x = NULL, net_y = NULL WHERE project_id = ?', id);
    run(`UPDATE task_dependency SET route_out = NULL, route_y = NULL, route_in = NULL, route_from = NULL, route_to = NULL
          WHERE successor_id IN (SELECT id FROM task WHERE project_id = ?)`, id);
  });
  res.status(204).end();
}));

/** What a change would do, without making it. The impact panel reads this before every edit and delete. */
router.post('/tasks/preview', handle((req, res) => {
  const projectId = intParam(req.body?.project_id);
  if (projectId == null || !get('SELECT id FROM project WHERE id = ?', projectId)) throw bad('A valid project is required');
  res.json(previewChange(projectId, changeFrom(req, projectId)));
}));

// ---------------------------------------------------------------- resources

router.get('/resources', handle((_req, res) => res.json(listResources())));

/** Rename or (de)activate. Renaming onto someone else's name is a merge, so it is refused here. */
router.patch('/resources/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<{ id: number; name: string; active: number }>('SELECT * FROM resource WHERE id = ?', id);
  if (!existing) throw missing('Person');
  let name = existing.name;
  if (req.body?.name != null) {
    name = cleanResourceName(nonEmpty(req.body.name, 'Name'));
    const parsed = parseResources(name);
    if (!parsed.ok) throw bad(parsed.error);
    if (parsed.names.length !== 1 || parsed.names[0] !== name) throw bad('A name cannot contain , or ;');
    if (name.length > RESOURCE_NAME_MAX) throw bad(`A name can be at most ${RESOURCE_NAME_MAX} characters`);
    const other = get<{ id: number; name: string }>('SELECT id, name FROM resource WHERE name_key = ? AND id <> ?', resourceKey(name), id);
    if (other) throw new HttpError(409, `${other.name} already exists. Merge into them instead.`);
  }
  const active = req.body?.active != null ? (req.body.active ? 1 : 0) : existing.active;
  const was = get<{ rate: number | null }>('SELECT rate FROM resource WHERE id = ?', id)!.rate;
  const rate = req.body?.rate !== undefined ? moneyParam(req.body.rate, 'A day rate') : was;
  transaction(() => {
    if (name !== existing.name) audit('resource', id, 'name', existing.name, name);
    if (rate !== was) audit('resource', id, 'rate', was, rate);
    run('UPDATE resource SET name = ?, name_key = ?, active = ?, rate = ? WHERE id = ?', name, resourceKey(name), active, rate, id);
  });
  res.json(listResources().find((r) => r.id === id));
}));

/** Fold one person into another: their tasks move across, and they go. For typos. */
router.post('/resources/:id/merge', handle((req, res) => {
  const id = Number(req.params.id);
  const into = intParam(req.body?.into);
  const from = get<{ id: number; name: string }>('SELECT id, name FROM resource WHERE id = ?', id);
  const to = into != null ? get<{ id: number; name: string }>('SELECT id, name FROM resource WHERE id = ?', into) : undefined;
  if (!from) throw missing('Person');
  if (!to) throw bad('Choose who to merge into');
  if (to.id === from.id) throw bad('Choose someone else to merge into');
  transaction(() => {
    // Where both were on a task, the one merged into keeps their place.
    run(`INSERT OR IGNORE INTO task_resource (task_id, resource_id, sort_order)
         SELECT task_id, ?, sort_order FROM task_resource WHERE resource_id = ?`, to.id, from.id);
    run('DELETE FROM resource WHERE id = ?', from.id);
    audit('resource', to.id, 'merged', from.name, to.name);
  });
  res.json(listResources().find((r) => r.id === to.id));
}));

router.delete('/resources/:id', handle((req, res) => {
  const id = Number(req.params.id);
  const existing = get<{ name: string }>('SELECT name FROM resource WHERE id = ?', id);
  if (!existing) throw missing('Person');
  transaction(() => {
    run('DELETE FROM resource WHERE id = ?', id);
    audit('resource', id, 'deleted', existing.name, null);
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------- holidays

router.get('/holidays', handle((_req, res) => res.json(listHolidays())));

router.post('/holidays', handle((req, res) => {
  const date = requireDate(req.body?.date, 'date');
  const name = nonEmpty(req.body?.name, 'Holiday name');
  transaction(() => {
    run('INSERT OR REPLACE INTO holiday (date, name) VALUES (?, ?)', date, name);
    // Durations count working days, so a new holiday moves every plan across it.
    replanAll();
  });
  res.status(201).json({ date, name });
}));

router.delete('/holidays/:date', handle((req, res) => {
  transaction(() => {
    run('DELETE FROM holiday WHERE date = ?', req.params.date);
    replanAll();
  });
  res.status(204).end();
}));

// ---------------------------------------------------------------- assistant settings

router.get('/assistant/settings', handle((_req, res) => res.json(assistantSettings())));

/** Which LLM providers this server can use now; a real one needs its key in the environment. */
router.get('/assistant/providers', handle((_req, res) => res.json(providerStatus())));

// Settings are not plan state: no write here can move a date, so none replans.
router.patch('/assistant/settings', handle((req, res) => {
  let patch: ReturnType<typeof cleanSettingsPatch>;
  try {
    patch = cleanSettingsPatch(req.body);
  } catch (err) {
    throw bad((err as Error).message);
  }
  transaction(() => {
    for (const [key, value] of Object.entries(patch.set)) {
      run(`INSERT INTO assistant_setting (key, value) VALUES (?, ?)
           ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`, key, JSON.stringify(value));
    }
    for (const key of patch.reset) run('DELETE FROM assistant_setting WHERE key = ?', key);
  });
  res.json(assistantSettings());
}));

// ---------------------------------------------------------------- assistant

function assistantProject(req: Request): number {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM project WHERE id = ?', id)) throw missing('Project');
  return id;
}

/** What the assistant says about a plan. `date` sets the status date; today by default. */
router.get('/projects/:id/assistant', handle((req, res) => {
  const id = assistantProject(req);
  const date = req.query.date == null ? undefined : requireDate(req.query.date, 'date');
  res.json(assistantReport(id, date));
}));

/** Set a warning aside. It stays listed, greyed, and comes back when what it concerns changes. */
router.post('/projects/:id/assistant/dismiss', handle((req, res) => {
  const id = assistantProject(req);
  const key = nonEmpty(req.body?.key, 'key');
  const rule = key.split(':')[0];
  if (key.length > 2000 || !/^[PSH]\d$/.test(rule)) throw bad('That is not a warning key');
  run('INSERT OR REPLACE INTO assistant_dismissal (key, project_id, rule) VALUES (?, ?, ?)', key, id, rule);
  res.json(assistantReport(id, req.body?.date == null ? undefined : requireDate(req.body.date, 'date')));
}));

router.post('/projects/:id/assistant/restore', handle((req, res) => {
  const id = assistantProject(req);
  run('DELETE FROM assistant_dismissal WHERE project_id = ? AND key = ?', id, nonEmpty(req.body?.key, 'key'));
  res.json(assistantReport(id, req.body?.date == null ? undefined : requireDate(req.body.date, 'date')));
}));

/** Better plans: a bounded search, run when asked rather than on every edit. */
router.get('/projects/:id/assistant/suggestions', handle((req, res) => {
  const id = assistantProject(req);
  res.json(suggestionReport(id, req.query.date == null ? undefined : requireDate(req.query.date, 'date'), req.query.focus === 'people' ? 'people' : undefined));
}));

/** What applying a suggestion (or any of its moves) would do, before it is done. */
router.post('/projects/:id/assistant/preview', handle((req, res) => {
  const id = assistantProject(req);
  res.json(previewOps(id, opsFrom(req.body?.ops)));
}));

/**
 * The plan as it is and as a suggestion would leave it, for the review page.
 * Writes nothing; 409 when the plan has changed since the suggestion's version.
 */
router.post('/projects/:id/assistant/review', handle((req, res) => {
  const id = assistantProject(req);
  const version = req.body?.version == null ? null : String(req.body.version);
  const date = req.body?.date == null ? undefined : requireDate(req.body.date, 'date');
  res.json(reviewOps(id, opsFrom(req.body?.ops), version, date));
}));

/** Apply a suggestion through the plan's write path. Returns the plan and the ops that undo it. */
router.post('/projects/:id/assistant/apply', handle((req, res) => {
  const id = assistantProject(req);
  const version = req.body?.version == null ? null : String(req.body.version);
  const undo = applyOps(id, opsFrom(req.body?.ops), version);
  res.json({ plan: planResponse(id), undo });
}));

/**
 * Ask the LLM advisor. With no provider turned on (the default) or when it fails,
 * the engine answers alone and says why; nothing leaves the machine unless a
 * provider was chosen in settings and its key set in the environment.
 */
router.post('/projects/:id/assistant/ask', (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = assistantProject(req);
    const question = typeof req.body?.question === 'string' && req.body.question.trim() ? req.body.question.trim().slice(0, 500) : null;
    const mode = req.body?.mode === 'replan' ? 'replan' : 'brief';
    advisorReply(id, { question, mode }).then((r) => res.json(r), next);
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- errors

router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err instanceof StaleError ? 409 : err instanceof PlanError ? 400 : 500;
  const message = err instanceof Error ? err.message : 'Something went wrong';
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
});
