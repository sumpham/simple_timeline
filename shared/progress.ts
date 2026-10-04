import { workingDays, type HolidaySet } from './dates.ts';
import type { ISODate, Task } from './types.ts';

/**
 * Percent complete, the one rule: the chart's progress band, a summary's
 * roll-up and earned value (shared/earnedValue.ts) all read it, so the Budget
 * tab earns exactly what the chart shows as done.
 */

type ProgressTask = Pick<Task, 'status' | 'duration' | 'actual_start'> & { progress?: number | null };

/**
 * Percent complete: what someone typed, else what the status says. Work in
 * progress with no figure is estimated from working days elapsed, capped short
 * of done, because only "Done" means done.
 */
export function progressOf(t: ProgressTask, today: ISODate, holidays?: HolidaySet): number {
  if (t.progress != null) return Math.max(0, Math.min(100, t.progress));
  if (t.status === 'done') return 100;
  if (t.status !== 'in_progress' || !t.actual_start || t.duration <= 0 || today < t.actual_start) return 0;
  return Math.min(95, Math.round((workingDays(t.actual_start, today, holidays) / t.duration) * 100));
}

/** A summary's progress: its tasks' progress weighted by their length. */
export function rolledProgress(parts: readonly { progress: number; duration: number }[]): number {
  if (!parts.length) return 0;
  const weight = parts.reduce((s, p) => s + Math.max(1, p.duration), 0);
  return Math.round(parts.reduce((s, p) => s + p.progress * Math.max(1, p.duration), 0) / weight);
}
