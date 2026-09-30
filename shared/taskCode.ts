import type { Task } from './types.ts';

/**
 * TaskIDs: the numbers people write in After. They are typed, not derived, so
 * moving a row never changes what a link says. A new task is offered the task
 * count plus one, or the next number after it that is still free.
 */

export const TASK_CODE_MAX = 999_999;

export function nextTaskCode(tasks: readonly Pick<Task, 'code'>[]): number {
  const used = new Set(tasks.map((t) => t.code).filter((c): c is number => c != null));
  let code = tasks.length + 1;
  let guard = 0;
  while (used.has(code) && guard++ <= tasks.length) code++;
  return code;
}

/** TaskID to task id; a task without one answers to its row number, as before IDs existed. */
export function taskIdsByCode(tasks: readonly Pick<Task, 'id' | 'code'>[]): Map<number, number> {
  return new Map(tasks.map((t, i) => [t.code ?? i + 1, t.id]));
}

/** Task id to TaskID, the other way round. */
export function codesById(tasks: readonly Pick<Task, 'id' | 'code'>[]): Map<number, number> {
  return new Map(tasks.map((t, i) => [t.id, t.code ?? i + 1]));
}
