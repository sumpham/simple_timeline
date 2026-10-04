/**
 * The smart assistant's server side (reqs/smart_assistant.md): load what the
 * pure engine in shared/assistant/ reads, run it, and stamp on dismissals. It
 * writes nothing but settings and dismissals; a suggestion (later phases) is
 * applied through the ordinary task routes, so it goes through replan.
 */
import { all, run, transaction } from './db.ts';
import { compareBaseline, holidaySet, listBookings, listEnvironments, listTasks, resolvedKeys, workElsewhere } from './queries.ts';
import { applyChange, downstreamImpact, loadState, outcomeOf, PlanError, projectStart, replanWithDownstream, withDownstream, writeState, type Change, type PlanState, type TaskFields } from './plan.ts';
import { conflictChanges, planImpact } from '../shared/plan.ts';
import { CREATED_ID, predecessorsOf, type OpFields, type PlanOp } from '../shared/assistant/moves.ts';
import { createSearch, planVersion, suggest, type SearchContext, type Suggestion, type SuggestionReport } from '../shared/assistant/optimise.ts';
import { offsetOf, unmaskText } from '../shared/assistant/digest.ts';
import { estimateTokens, fitDigest } from '../shared/assistant/budget.ts';
import { checkMove, judgeMoves, opsOfMove, type AdvisorReply } from '../shared/assistant/validate.ts';
import { seedOf } from '../shared/assistant/random.ts';
import { buildReview, type PlanReview } from '../shared/assistant/review.ts';
import { ask, RUBRIC } from './llm/orchestrate.ts';
import { applyResolutions, detectConflicts } from '../shared/conflicts.ts';
import { isValidISODate, today } from '../shared/dates.ts';
import { planFacts } from '../shared/assistant/facts.ts';
import { assess, day, type AssistantReport } from '../shared/assistant/rules.ts';
import { mergeSettings, type AssistantSettings } from '../shared/assistant/settings.ts';
import { providerFor } from './llm/index.ts';
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

/** The facts and warnings for one plan on a status date: what the drawer shows and the advisor reads. */
function projectAssessment(projectId: number, statusDate: ISODate) {
  const state = loadState(projectId);
  const outcome = outcomeOf(state);
  if ('cycle' in outcome) throw new PlanError('This plan has a dependency loop. Remove one of its links.');
  const settings = assistantSettings();
  const holidays = holidaySet();

  // The baseline the plan compares with, as the chart and the variance columns read it.
  const baseline = compareBaseline(projectId);
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
    elsewhere: elsewhereWork(projectId),
  });
  const dismissed = new Set(all<{ key: string }>(
    'SELECT key FROM assistant_dismissal WHERE project_id = ?', projectId,
  ).map((r) => r.key));
  const findings = assess(facts, { long_task_days: settings.long_task_days }, names)
    .map((f) => (dismissed.has(f.key) ? { ...f, dismissed: true } : f));
  return { state, facts, findings, settings, names, holidays };
}

/** Everything the assistant says about one project's plan on a status date. */
export function assistantReport(projectId: number, statusDate: ISODate = today()): AssistantReport {
  const { facts, findings, settings } = projectAssessment(projectId, statusDate);
  const { provider } = providerFor(settings);
  return {
    status_date: statusDate, findings, forecast: facts.forecast, suggestions: [],
    advisor: { provider: provider.id, on: provider.id !== 'none' },
  };
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
  // The baseline the plan compares with, as the chart and the variance columns read it.
  const baseline = compareBaseline(projectId);
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
    elsewhere: elsewhereWork(projectId),
    external: state.external,
    names: new Map(all<{ id: number; name: string }>('SELECT id, name FROM resource').map((r) => [r.id, r.name])),
    apply: (s, op) => {
      const next = applyChange({ ...state, tasks: s.tasks as Task[], deps: s.deps as TaskDependency[] }, changeOf(op, null));
      return { tasks: next.tasks, deps: next.deps };
    },
  };
  return { state, ctx, version: planVersion(state, state.project) };
}

/** This plan's people's open work in other plans, as the overlap rule reads it. */
function elsewhereWork(projectId: number) {
  return workElsewhere(projectId).map((t) => ({
    task_id: t.task_id, project_id: t.project_id, resource_ids: t.resource_ids, start: t.start, end: t.end,
    name: t.name, code: t.code, project_name: t.project_name,
  }));
}

/** Better plans; `only: 'people'` levels people and nothing else (the drawer's Level people). */
export function suggestionReport(projectId: number, statusDate?: ISODate, only?: 'people'): SuggestionReport {
  const { state, ctx, version } = searchContext(projectId, statusDate);
  const report = suggest(ctx, state, version, { only });
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
  const after = outcomeOf(s);
  return withDownstream(projectId, planImpact(before, after, ctx.impact), after);
}

/**
 * The plan as it is and as `ops` would leave it, for the review page
 * (reqs/pm_features.md §8). Read-only, and built by the same functions as the
 * search and the save, so what it shows is what Apply writes. Refused like
 * Apply when the plan has changed since `version`.
 */
export function reviewOps(projectId: number, ops: PlanOp[], version: string | null, statusDate?: ISODate): PlanReview {
  const { state, ctx, version: now } = searchContext(projectId, statusDate);
  if (version != null && version !== now) {
    throw new StaleError('The plan has changed since this was worked out. Find a better plan again.');
  }
  const names = new Map(all<{ id: number; name: string }>('SELECT id, name FROM resource').map((r) => [r.id, r.name]));
  const elsewhere = workElsewhere(projectId).map((t) => ({
    task_id: t.task_id, project_id: t.project_id, resource_ids: t.resource_ids, start: t.start, end: t.end,
  }));
  const rates = new Map(all<{ id: number; rate: number | null }>('SELECT id, rate FROM resource').map((r) => [r.id, r.rate]));
  const review = buildReview(ctx, state, ops, { version: now, elsewhere, names, rates, currency: state.project.currency ?? 'EUR' });
  if ('refused' in review) throw new PlanError(review.refused);
  // Plans linked after this one, planned on copies with the moved dates (reqs/pm_features.md §7).
  let s: PlanState = state;
  for (const op of ops) s = applyChange(s, changeOf(op, null));
  const after = outcomeOf(s);
  const downstream = 'cycle' in after ? [] : downstreamImpact(projectId, after);
  review.diff.downstream = downstream;
  const wd = (n: number) => `${Math.abs(n)} working day${Math.abs(n) === 1 ? '' : 's'}`;
  for (const d of downstream) {
    if (d.days > 0) review.verdict.worse.push(`Moves ${d.name}’s finish ${wd(d.days)} later.`);
    for (const c of d.clashes_added) review.verdict.worse.push(`Double-books ${c.env_name} in ${d.name}, ${day(c.start_date)} – ${day(c.end_date)}.`);
    if (d.days < 0) review.verdict.better.push(`${d.name} finishes ${wd(d.days)} sooner.`);
  }
  return review;
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
    replanWithDownstream(projectId);
    return undo;
  });
}

export class StaleError extends Error {}

// ---------------------------------------------------------------- the LLM advisor

const answers = new Map<string, AdvisorReply>();
const ANSWER_CACHE = 30;

/** Ask the advisor about a plan. Never throws for an LLM failure: the engine answers instead, saying why. */
export async function advisorReply(projectId: number, o: { question: string | null; mode: 'brief' | 'replan' }): Promise<AdvisorReply> {
  const statusDate = today();
  const a = projectAssessment(projectId, statusDate);
  const { provider, note } = providerFor(a.settings);

  const engine = (why: string, usage: AdvisorReply['usage'] = null): AdvisorReply => {
    const open = a.findings.filter((f) => !f.dismissed);
    const fc = a.facts.forecast;
    const lines = open.slice(0, 3).map((f) => f.text);
    const headline = fc && fc.on_time != null ? `The plan has a ${Math.round(fc.on_time * 100)}% chance of meeting its target (P80 ${fc.p80}).` : '';
    return {
      source: 'engine',
      note: why,
      briefing: [headline, ...lines].filter(Boolean).join(' ') || 'Nothing on this plan needs attention now.',
      risks: open.map((f, i) => ({ key: f.key, rank: i + 1, why: f.text })),
      suggestions: o.mode === 'replan' ? suggestionReport(projectId, statusDate).suggestions : [],
      rejected: [],
      usage,
      provider: provider.id,
      cached: false,
    };
  };
  if (provider.id === 'none') return engine(note ?? 'No LLM provider is turned on, so nothing left this machine. The engine answered on its own.');

  // The digest, fitted to the budget after the rubric's share.
  const tasks = a.state.tasks;
  const parent = new Map(tasks.map((t) => [t.id, t.parent_id ?? null]));
  const branchOf = new Map(tasks.map((t) => {
    let top: number | null = null;
    for (let p = parent.get(t.id) ?? null, guard = 0; p != null && guard < 64; p = parent.get(p) ?? null, guard++) top = p;
    return [t.id, top];
  }));
  const digest = fitDigest({
    facts: a.facts,
    findings: a.findings,
    notes: new Map(tasks.map((t) => [t.id, t.note])),
    people: a.names,
    environments: new Map(listEnvironments(a.state.project.team_id).map((e) => [e.id, e.name])),
    branchOf,
  }, {
    sendPeople: a.settings.llm_send_people,
    sendOtherProjects: a.settings.llm_send_other_projects,
    sendNotes: a.settings.llm_send_notes,
  }, a.settings.llm_token_budget, estimateTokens(RUBRIC));

  const tier = o.mode === 'replan' ? 'strong' : 'fast';
  const model = tier === 'strong' ? a.settings.llm_model_strong : a.settings.llm_model_fast;
  const key = seedOf(JSON.stringify([provider.id, model, o.mode, o.question, digest.network, digest.state])).toString(36);
  const hit = answers.get(key);
  if (hit) return { ...hit, cached: true };

  // The tools, answered by the engine.
  const { state, ctx, version } = searchContext(projectId, statusDate);
  const search = createSearch(ctx, state);
  if (!search) return engine('This plan has a dependency loop.');
  search.withForecast(search.root);
  const off = (d: ISODate | null | undefined) => (d ? `${offsetOf(statusDate, d, ctx.holidays) >= 0 ? '+' : ''}${offsetOf(statusDate, d, ctx.holidays)}` : '-');
  const byCode = new Map(search.root.facts.tasks.map((t) => [t.code, t]));
  const tools = {
    get_task: (args: unknown) => {
      const t = byCode.get((args as { task?: number })?.task ?? -1);
      if (!t) return 'There is no such task.';
      const code = (id: number) => search.root.facts.byId.get(id)?.code ?? id;
      const raw = tasks.find((x) => x.id === t.id);
      const warnings = a.findings.filter((f) => !f.dismissed && f.task_ids.includes(t.id)).map((f) => `${f.key}: ${f.text}`);
      return [
        `Task ${t.code} "${t.name}"${t.summary ? ' (summary)' : ''}: status ${t.status}, ${t.duration} working days, best ${t.best ?? '~'}, worst ${t.worst ?? '~'}`,
        `start ${off(t.start)}, end ${off(t.end)}, total float ${t.total_float}, free float ${t.free_float}${t.critical ? ', critical' : t.near_critical ? ', near-critical' : ''}`,
        `waits for ${t.preds.map(code).join(', ') || 'nothing'}; feeds ${t.succs.map(code).join(', ') || 'nothing'}`,
        ...(t.not_before ? [`start no earlier than ${off(t.not_before)}${t.driven_by_constraint ? ' (holding it back)' : ''}`] : []),
        ...(t.progress != null ? [`${t.progress}% done${t.spi != null ? `, pace ${t.spi.toFixed(2)}` : ''}`] : []),
        ...(a.settings.llm_send_notes && raw?.note ? [`note: ${raw.note.slice(0, 300)}`] : []),
        ...warnings,
      ].join('\n');
    },
    simulate: (args: unknown) => {
      const moves = (args as { moves?: unknown[] })?.moves;
      if (!Array.isArray(moves) || !moves.length) return 'Give one or more moves.';
      const ops: PlanOp[] = [];
      for (const m of moves.slice(0, 5)) {
        const checked = checkMove(m as Record<string, unknown>);
        if (typeof checked === 'string') return `Not a valid move: ${checked}.`;
        const got = opsOfMove(search, ctx, checked);
        if (typeof got === 'string') return `Not a valid move: ${got}.`;
        ops.push(...got);
      }
      const e = search.tryOps(search.root.state, ops);
      if (!e) return 'A save would refuse that (for example a loop, or a field a summary does not have).';
      search.withForecast(e);
      const r = search.root;
      const cleared = e === r ? [] : conflictChanges(r.outcome, e.outcome, ctx.impact).cleared;
      return [
        `finish ${off(r.finish)} -> ${off(e.finish)}`,
        `P80 ${off(r.forecast?.p80)} -> ${off(e.forecast?.p80)}`,
        ...(r.forecast?.on_time != null ? [`chance on time ${Math.round(r.forecast.on_time * 100)}% -> ${Math.round((e.forecast?.on_time ?? 0) * 100)}%`] : []),
        `new double-bookings: ${e.newClashes}${e.newClashes ? ' (the engine will drop this)' : ''}`,
        `double-bookings of this project: ${r.clashes} -> ${e.clashes}${cleared.length ? ` (clears ${cleared.map((c) => c.env_name).join(', ')})` : ''}`,
      ].join('\n');
    },
  };

  const started = Date.now();
  const result = await ask({ provider, tier, model, network: digest.network, state: digest.state, question: o.question, tools });
  const usage = {
    ...result.usage, prompt_tokens: digest.tokens, digest_level: digest.level, shown: digest.shown, total: digest.total,
    turns: result.turns, tools: result.tools,
  };
  run(`INSERT INTO assistant_llm_log (project_id, provider, model, tier, digest_level, input_tokens, output_tokens, cache_read, cache_write, turns, latency_ms, outcome)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    projectId, provider.id, result.model ?? model, tier, digest.level, result.usage.input, result.usage.output,
    result.usage.cacheRead ?? 0, result.usage.cacheWrite ?? 0, result.turns, Date.now() - started,
    result.answer ? 'answered' : result.unavailable ? 'unavailable' : `failed: ${result.error ?? ''}`.slice(0, 200));

  if (!result.answer) return engine(`${result.error ?? 'The advisor did not answer'}. The engine answered on its own.`, usage);

  const known = new Set(a.findings.map((f) => f.key));
  const verdicts = judgeMoves(ctx, state, version, result.answer.moves, digest.unmask);
  const reply: AdvisorReply = {
    source: 'advisor',
    note: digest.over ? 'The plan was too large for the token budget even at its shortest; the advisor saw the critical path only.' : null,
    briefing: unmaskText(result.answer.briefing, digest.unmask),
    risks: result.answer.risks.filter((r) => known.has(r.key)).map((r) => ({ ...r, why: unmaskText(r.why, digest.unmask) })),
    suggestions: verdicts.flatMap((v) => (v.suggestion ? [v.suggestion] : [])),
    rejected: verdicts.flatMap((v) => (v.rejected ? [{ title: `Task ${v.move.task}: ${JSON.stringify(v.move.change)}`, reason: v.rejected }] : [])),
    usage,
    provider: provider.id,
    cached: false,
  };
  answers.set(key, reply);
  if (answers.size > ANSWER_CACHE) answers.delete(answers.keys().next().value!);
  return reply;
}
