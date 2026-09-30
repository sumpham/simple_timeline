/**
 * Three-point estimates: a task's best and worst case beside its planned
 * duration, in working days (reqs/smart_assistant.md §8.1). They feed only the
 * assistant's forecast. Like people on a task, they are not plan state: an edit
 * to them never replans and never moves a date.
 */

export const ESTIMATE_MAX = 1000;

export type Estimate = { duration_low?: number | null; duration_high?: number | null };

/**
 * Why a best/worst pair cannot stand beside a duration, or null when it can.
 * Blank is always fine: the forecast then uses its default range.
 */
export function estimateError(duration: number, low: number | null | undefined, high: number | null | undefined): string | null {
  for (const [v, word] of [[low, 'Best'], [high, 'Worst']] as const) {
    if (v == null) continue;
    if (!Number.isInteger(v) || v < 0 || v > ESTIMATE_MAX) return `${word} is a whole number of working days, 0 to ${ESTIMATE_MAX}`;
  }
  if (low != null && low > duration) return `Best case (${low}) cannot be longer than the planned ${duration} days`;
  if (high != null && high < duration) return `Worst case (${high}) cannot be shorter than the planned ${duration} days`;
  return null;
}

/**
 * The range the forecast samples for a task, in working days: best, planned,
 * worst. A missing end takes the default skew real plans show (a little
 * shorter, rather longer). A duration changed after the estimate was typed is
 * always inside the range: the range stretches to hold it.
 */
export const DEFAULT_BEST = 0.9;
export const DEFAULT_WORST = 1.3;

export function rangeOf(t: { duration: number } & Estimate): { low: number; mode: number; high: number; typed: boolean } {
  const mode = Math.max(0, t.duration);
  const low = t.duration_low != null ? Math.min(t.duration_low, mode) : mode * DEFAULT_BEST;
  const high = t.duration_high != null ? Math.max(t.duration_high, mode) : mode * DEFAULT_WORST;
  return { low, mode, high, typed: t.duration_low != null || t.duration_high != null };
}
