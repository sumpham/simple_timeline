/**
 * The smart assistant's server side (reqs/smart_assistant.md): load what the
 * pure engine in shared/assistant/ reads, run it, and stamp on dismissals. It
 * writes nothing but settings and dismissals; a suggestion (later phases) is
 * applied through the ordinary task routes, so it goes through replan.
 */
import { all } from './db.ts';
import { holidaySet, listBookings, listTasks, resolvedKeys } from './queries.ts';
import { loadState, outcomeOf, PlanError, projectStart } from './plan.ts';
import { applyResolutions, detectConflicts } from '../shared/conflicts.ts';
import { today } from '../shared/dates.ts';
import { planFacts } from '../shared/assistant/facts.ts';
import { assess, type AssistantReport } from '../shared/assistant/rules.ts';
import { mergeSettings, type AssistantSettings } from '../shared/assistant/settings.ts';
import type { ISODate } from '../shared/types.ts';

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
  });
  const dismissed = new Set(all<{ key: string }>(
    'SELECT key FROM assistant_dismissal WHERE project_id = ?', projectId,
  ).map((r) => r.key));
  const findings = assess(facts, { long_task_days: settings.long_task_days }, names)
    .map((f) => (dismissed.has(f.key) ? { ...f, dismissed: true } : f));

  return { status_date: statusDate, findings, forecast: null, suggestions: [] };
}
