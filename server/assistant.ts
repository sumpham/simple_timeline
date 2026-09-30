/**
 * The smart assistant's server side (reqs/smart_assistant.md): load what the
 * pure engine in shared/assistant/ reads, run it, and stamp on dismissals. It
 * writes nothing but settings and dismissals; a suggestion (later phases) is
 * applied through the ordinary task routes, so it goes through replan.
 */
import { all, transaction } from './db.ts';
import { holidaySet, listBookings, listEnvironments, listTasks, resolvedKeys } from './queries.ts';
import { applyChange, loadState, outcomeOf, PlanError, projectStart, replan, writeState, type Change, type PlanState, type TaskFields } from './plan.ts';
import { planImpact } from '../shared/plan.ts';
import { CREATED_ID, predecessorsOf, type OpFields, type PlanOp } from '../shared/assistant/moves.ts';
import { planVersion, suggest, type SearchContext, type SuggestionReport } from '../shared/assistant/optimise.ts';
import { applyResolutions, detectConflicts } from '../shared/conflicts.ts';
import { isValidISODate, today } from '../shared/dates.ts';
import { planFacts } from '../shared/assistant/facts.ts';
import { assess, type AssistantReport } from '../shared/assistant/rules.ts';
import { mergeSettings, type AssistantSettings } from '../shared/assistant/settings.ts';
import type { ISODate, LinkType, PlanImpact, Task, TaskDependency } from '../shared/types.ts';

export function assistantSettings(): AssistantSettings {
  const stored: Record<string, unknown> = {};
  for (const row of all<{ key: string; value: string }>('SELECT key, value FROM assistant_setting')) {
    try {
      stored[row.key] = JSON.parse(row.value);
    } catch {
      // An unreadable row reads as the default.
    }
  }
  return mergeSettings(stored);
}

/** Everything the assistant says about one project's plan on a status date. */
export function assistantReport(projectId: number, statusDate: ISODate = today()): AssistantReport {
  const state = loadState(projectId);
  const outcome = outcomeOf(state);
  if ('cycle' in outcome) throw new PlanError('This plan has a dependency loop. Remove one of its links.');
  const settings = assistantSettings();
  const holidays = holidaySet();

  const baseline = new Map(all<{ task_id: number; start_date: ISODate; end_date: ISODate }>(
    'SELECT task_id, start_date, end_date FROM task_baseline WHERE project_id = ?', projectId,
  ).map((b) => [b.task_id, { start: b.start_date, end: b.end_date }]));
  const people = new Map(listTasks(projectId).map((t) => [t.id, t.resource_ids ?? []]));
  const names = new Map(all<{ id: number; name: string }>('SELECT id, name FROM resource').map((r) => [r.id, r.name]));
  // Over the team's whole booking set, as the board counts them: another project's
  // booking is half of every clash this plan is in.
  const conflicts = applyResolutions(
    detectConflicts(listBookings({ teamId: state.project.team_id })),
    new Set(resolvedKeys(state.project.team_id)),
  );

  const facts = planFacts({
    project: state.project,
    projectStart: projectStart(state),
    outcome,
    baseline,
    people,
    conflicts,
    statusDate,
    nearCriticalDays: settings.near_critical_days,
    holidays,
    forecastRuns: settings.forecast_runs,
  });
  const dismissed = new Set(all<{ key: string }>(
    'SELECT key FROM assistant_dismissal WHERE project_id = ?', projectId,
  ).map((r) => r.key));
  const findings = assess(facts, { long_task_days: settings.long_task_days }, names)
    .map((f) => (dismissed.has(f.key) ? { ...f, dismissed: true } : f));

  return { status_date: statusDate, findings, forecast: facts.forecast, suggestions: [] };
}

// ---------------------------------------------------------------- better plans

/** A suggestion op as the plan's write path takes it. */
function changeOf(op: PlanOp, created: number | null): Change {
  const id = (x: number) => (x === CREATED_ID ? created ?? CREATED_ID : x);
  const fields = (f: OpFields): TaskFields => ({
    ...f,
    ...(f.predecessors ? { predecessors: f.predecessors.map((p) => ({ ...p, id: id(p.id) })) } : {}),
  });
  if (op.op === 'create') return { op: 'create', fields: fields(op.fields) as TaskFields & { name: string }, after_id: op.after_id == null ? null : id(op.after_id) };
  if (op.op === 'update') return { op: 'update', id: id(op.id), fields: fields(op.fields) };
  return { op: 'delete', id: id(op.id), bridge: false };
}

/** Ops from a request, checked for shape; the write path checks everything else. */
export function opsFrom(raw: unknown): PlanOp[] {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw new PlanError('A suggestion is a list of 1 to 20 changes');
  const int = (v: unknown) => (Number.isInteger(v) ? (v as number) : null);
  const fieldsOf = (f: unknown): OpFields => {
    if (!f || typeof f !== 'object') throw new PlanError('Each change needs fields');
    const o = f as Record<string, unknown>;
    const out: OpFields = {};
    if (o.name !== undefined) { if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > 200) throw new PlanError('A task name is 1 to 200 characters'); out.name = o.name.trim(); }
    if (o.duration !== undefined) { const d = int(o.duration); if (d == null || d < 0 || d > 1000) throw new PlanError('Duration is 0 to 1000 working days'); out.duration = d; }
    if (o.not_before !== undefined) { if (o.not_before !== null && !isValidISODate(o.not_before)) throw new PlanError('not_before must be a date or null'); out.not_before = o.not_before as ISODate | null; }
    if (o.environment_id !== undefined) { if (o.environment_id !== null && int(o.environment_id) == null) throw new PlanError('environment_id must be an id or null'); out.environment_id = o.environment_id as number | null; }
    if (o.predecessors !== undefined) {
      if (!Array.isArray(o.predecessors)) throw new PlanError('predecessors must be a list');
      out.predecessors = o.predecessors.map((p) => {
        const q = p as Record<string, unknown>;
        const id = int(q?.id);
        const lag = int(q?.lag ?? 0);
        const type = q?.type ?? 'FS';
        if (id == null || lag == null || !['FS', 'SS', 'FF'].includes(type as string)) throw new PlanError('Each predecessor needs an id, a whole-day lag and a type');
        return { id, lag, type: type as LinkType };
      });
    }
    return out;
  };
  return raw.map((r) => {
    const o = r as Record<string, unknown>;
    if (o?.op === 'update' && int(o.id) != null) return { op: 'update' as const, id: o.id as number, fields: fieldsOf(o.fields) };
    if (o?.op === 'delete' && int(o.id) != null) return { op: 'delete' as const, id: o.id as number };
    if (o?.op === 'create') {
      const fields = fieldsOf(o.fields);
      if (!fields.name) throw new PlanError('A new task needs a name');
      return { op: 'create' as const, fields: fields as OpFields & { name: string }, after_id: int(o.after_id) };
    }
    throw new PlanError('Each change is an update, a create or a delete');
  });
}

/** What the better-plan search reads for one project, with the save's own applyChange. */
export function searchContext(projectId: number, statusDate: ISODate = today()) {
  const state = loadState(projectId);
  const teamId = state.project.team_id;
  const settings = assistantSettings();
  const holidays = holidaySet();
  const environments = listEnvironments(teamId);
  const baseline = new Map(all<{ task_id: number; start_date: ISODate; end_date: ISODate }>(
    'SELECT task_id, start_date, end_date FROM task_baseline WHERE project_id = ?', projectId,
  ).map((b) => [b.task_id, { start: b.start_date, end: b.end_date }]));
  const ctx: SearchContext = {
    project: { id: projectId, name: state.project.name, priority: state.project.priority, target_date: state.project.target_date ?? null },
    projectStart: projectStart(state),
    statusDate,
    holidays,
    bookings: state.bookings,
    impact: {
      project: { id: projectId, name: state.project.name, priority: state.project.priority, target_date: state.project.target_date },
      teamBookings: listBookings({ teamId }),
      environments,
      resolved: new Set(resolvedKeys(teamId)),
      holidays,
    },
    environments,
    people: new Map(listTasks(projectId).map((t) => [t.id, t.resource_ids ?? []])),
    baseline,
    nearCriticalDays: settings.near_critical_days,
    longTaskDays: settings.long_task_days,
    forecastRuns: Math.min(settings.forecast_runs, 300),
    apply: (s, op) => {
      const next = applyChange({ ...state, tasks: s.tasks as Task[], deps: s.deps as TaskDependency[] }, changeOf(op, null));
      return { tasks: next.tasks, deps: next.deps };
    },
  };
  return { state, ctx, version: planVersion(state, state.project) };
}

export function suggestionReport(projectId: number, statusDate?: ISODate): SuggestionReport {
  const { state, ctx, version } = searchContext(projectId, statusDate);
  const report = suggest(ctx, state, version);
  if (!report) throw new PlanError('This plan has a dependency loop. Remove one of its links.');
  return report;
}

/** What a list of ops would do, as the impact banner shows a hand edit. */
export function previewOps(projectId: number, ops: PlanOp[]): PlanImpact {
  const { state, ctx } = searchContext(projectId);
  const before = outcomeOf(state);
  if ('cycle' in before) throw new PlanError('This plan has a dependency loop. Remove one of its links.');
  let s: PlanState = state;
  for (const op of ops) s = applyChange(s, changeOf(op, null));
  return planImpact(before, outcomeOf(s), ctx.impact);
}

/**
 * Apply a suggestion through the write path, all or nothing, and replan once.
 * Refused when the plan has changed since `version`. Returns the ops that undo it.
 */
export function applyOps(projectId: number, ops: PlanOp[], version: string | null): PlanOp[] {
  return transaction(() => {
    const now = loadState(projectId);
    if (version != null && planVersion(now, now.project) !== version) {
      throw new StaleError('The plan has changed since this was worked out. Find a better plan again.');
    }
    let created: number | null = null;
    const undo: PlanOp[] = [];
    for (const op of ops) {
      const before = loadState(projectId);
      const change = changeOf(op, created);
      if (change.op === 'update') {
        const t = before.tasks.find((x) => x.id === change.id);
        if (!t) throw new PlanError('Task not found');
        const back: OpFields = {};
        for (const k of Object.keys(change.fields) as (keyof OpFields)[]) {
          if (k === 'predecessors') back.predecessors = predecessorsOf(before.deps, t.id);
          else (back as Record<string, unknown>)[k] = t[k] ?? null;
        }
        undo.unshift({ op: 'update', id: t.id, fields: back });
      }
      const id = writeState(before, applyChange(before, change));
      if (change.op === 'create') {
        created = id;
        undo.unshift({ op: 'delete', id: id! });
      }
    }
    replan(projectId);
    return undo;
  });
}

export class StaleError extends Error {}
