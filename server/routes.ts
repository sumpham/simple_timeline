import { Router, type Request, type Response, type NextFunction } from 'express';
import { all, audit, get, run, transaction } from './db.ts';
import { listBookings, listEnvironments, listHolidays, listProjects, listTeams } from './queries.ts';
import { applyResolutions, conflictKey, detectConflicts } from '../shared/conflicts.ts';
import { isValidISODate, isWorkingDay, snapToWorkingDay } from '../shared/dates.ts';
import { effectiveKind } from '../shared/bookings.ts';
import { holidaySet } from './queries.ts';
import { MARKERS, type Booking, type BookingKind, type Environment, type ISODate, type Marker, type Project } from '../shared/types.ts';

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

/** Keys of the resolved double-bookings for a team's environments, or every team's. */
function resolvedKeys(teamId?: number): string[] {
  const rows = teamId != null
    ? all<{ key: string }>(
      `SELECT r.key FROM conflict_resolution r JOIN environment e ON e.id = r.environment_id WHERE e.team_id = ?`,
      teamId,
    )
    : all<{ key: string }>('SELECT key FROM conflict_resolution');
  return rows.map((r) => r.key);
}

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
    `INSERT INTO project (team_id, parent_id, name, status, priority, owner, description, external_link)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    teamId, parentId, name,
    oneOf(req.body?.status, STATUSES, 'status', 'planned'),
    oneOf(req.body?.priority, PRIORITIES, 'priority', 'normal'),
    req.body?.owner ?? null, req.body?.description ?? null, req.body?.external_link ?? null,
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
  };

  run(
    'UPDATE project SET name = ?, status = ?, priority = ?, owner = ?, description = ?, external_link = ? WHERE id = ?',
    next.name, next.status, next.priority, next.owner, next.description, next.external_link, id,
  );
  res.json(get('SELECT * FROM project WHERE id = ?', id));
}));

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
  const { lastInsertRowid } = run(
    `INSERT INTO booking (project_id, environment_id, kind, start_date, end_date, confidence, optional, note, marker)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId, envId, kind, start, end,
    oneOf(req.body?.confidence, CONFIDENCES, 'confidence', 'committed'),
    req.body?.optional ? 1 : 0,
    noteValue(req.body?.note),
    markerValue(req.body?.marker, kind),
  );

  res.status(201).json({ ...get('SELECT * FROM booking WHERE id = ?', Number(lastInsertRowid)), adjusted });
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

  const requestedKind = req.body?.kind != null ? oneOf(req.body.kind, BOOKING_KINDS, 'kind') : existing.kind;
  const rawStart = req.body?.start_date != null ? requireDate(req.body.start_date, 'start_date') : existing.start_date;
  const rawEnd = requestedKind === 'RELEASE'
    ? rawStart
    : (req.body?.end_date != null ? requireDate(req.body.end_date, 'end_date') : existing.end_date);
  if (rawEnd < rawStart) throw bad('A booking cannot end before it starts');

  const { start, end, adjusted } = snapRange(rawStart, rawEnd);
  const kind = effectiveKind(requestedKind, start, end);
  const confidence = req.body?.confidence != null ? oneOf(req.body.confidence, CONFIDENCES, 'confidence') : existing.confidence;
  const optional = req.body?.optional != null ? (req.body.optional ? 1 : 0) : existing.optional;
  // undefined leaves a field alone; null clears it.
  const note = req.body?.note !== undefined ? noteValue(req.body.note) : existing.note;
  const marker = markerValue(req.body?.marker !== undefined ? req.body.marker : existing.marker, kind);

  // Dates are what people argue about, so every change to one is recorded.
  if (start !== existing.start_date) audit('booking', id, 'start_date', existing.start_date, start);
  if (end !== existing.end_date) audit('booking', id, 'end_date', existing.end_date, end);
  if (envId !== existing.environment_id) audit('booking', id, 'environment_id', existing.environment_id, envId);

  run(
    `UPDATE booking SET environment_id = ?, kind = ?, start_date = ?, end_date = ?, confidence = ?, optional = ?,
                        note = ?, marker = ?
      WHERE id = ?`,
    envId, kind, start, end, confidence, optional, note, marker, id,
  );
  res.json({ ...get('SELECT * FROM booking WHERE id = ?', id), adjusted });
}));

router.delete('/bookings/:id', handle((req, res) => {
  const id = Number(req.params.id);
  if (!get('SELECT id FROM booking WHERE id = ?', id)) throw missing('Booking');
  run('DELETE FROM booking WHERE id = ?', id);
  res.status(204).end();
}));

// ---------------------------------------------------------------- holidays

router.get('/holidays', handle((_req, res) => res.json(listHolidays())));

router.post('/holidays', handle((req, res) => {
  const date = requireDate(req.body?.date, 'date');
  const name = nonEmpty(req.body?.name, 'Holiday name');
  run('INSERT OR REPLACE INTO holiday (date, name) VALUES (?, ?)', date, name);
  res.status(201).json({ date, name });
}));

router.delete('/holidays/:date', handle((req, res) => {
  run('DELETE FROM holiday WHERE date = ?', req.params.date);
  res.status(204).end();
}));

// ---------------------------------------------------------------- errors

router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : 500;
  const message = err instanceof Error ? err.message : 'Something went wrong';
  if (status === 500) console.error(err);
  res.status(status).json({ error: message });
});
