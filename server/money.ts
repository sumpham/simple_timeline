/**
 * Money on the server (reqs/pm_features.md §6): what earned value reads for one
 * project, loaded once. The arithmetic is shared/earnedValue.ts's; this only
 * gathers rows. Cost is never plan state, so nothing here replans.
 */
import { all, get } from './db.ts';
import { compareBaseline, holidaySet, listTasks } from './queries.ts';
import { loadState, outcomeOf, PlanError } from './plan.ts';
import { costsOf, earnedValue, type CostInput, type EarnedValue, type Missing } from '../shared/earnedValue.ts';
import { today } from '../shared/dates.ts';
import type { ISODate } from '../shared/types.ts';

/** A project's tasks, schedule, people and rates: what a cost is made of. */
export function costInput(projectId: number): CostInput {
  const state = loadState(projectId);
  const outcome = outcomeOf(state);
  if ('cycle' in outcome) throw new PlanError('This plan has a dependency loop. Remove one of its links.');
  const tasks = listTasks(projectId);
  return {
    tasks,
    schedule: outcome.schedule.tasks,
    people: new Map(tasks.map((t) => [t.id, t.resource_ids ?? []])),
    rates: new Map(all<{ id: number; rate: number | null }>('SELECT id, rate FROM resource').map((r) => [r.id, r.rate])),
  };
}

/** Each task's planned cost now, for a baseline to keep. */
export function plannedCosts(projectId: number): Map<number, number | null> {
  return costsOf(costInput(projectId));
}

/** Earned value at a status date, against the baseline the plan compares with. */
export function projectEarnedValue(projectId: number, statusDate: ISODate = today()): EarnedValue | Missing {
  const input = costInput(projectId);
  const currency = get<{ currency: string }>('SELECT currency FROM project WHERE id = ?', projectId)?.currency ?? 'EUR';
  const costs = new Map(all<{ task_id: number; cost: number | null }>(
    `SELECT tb.task_id, tb.cost FROM task_baseline tb JOIN project p ON p.compare_baseline_id = tb.baseline_id WHERE p.id = ?`, projectId,
  ).map((r) => [r.task_id, r.cost]));
  const snapshot = new Map([...compareBaseline(projectId)].map(([id, b]) => [id, { ...b, cost: costs.get(id) ?? null }]));
  return earnedValue({ ...input, snapshot, statusDate, holidays: holidaySet(), currency });
}
