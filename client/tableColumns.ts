/**
 * The task table's column widths. The fixed layout keeps the chart's room
 * predictable, so a column that is too narrow cuts its text off; these widths
 * are fitted to what the plan actually holds, and a width someone drags by hand
 * wins until they double-click the column's edge to fit it again.
 */

export type ColumnKey =
  | 'row' | 'code' | 'wbs' | 'name' | 'env' | 'days' | 'best' | 'worst'
  | 'after' | 'who' | 'start' | 'finish' | 'float' | 'status';

export interface ColumnShow {
  wbs: boolean;
  estimates: boolean;
  who: boolean;
}

/** Widths before anything is measured, and the floor for the fixed columns. */
export const DEFAULT_WIDTH: Readonly<Record<ColumnKey, number>> = {
  row: 44, code: 48, wbs: 56, name: 220, env: 120, days: 52, best: 52, worst: 52,
  after: 72, who: 120, start: 114, finish: 114, float: 52, status: 140,
};

/** The columns a person can resize, and how far; the rest hold fixed values. */
export const RESIZABLE: Readonly<Partial<Record<ColumnKey, { min: number; max: number }>>> = {
  name: { min: 140, max: 480 },
  env: { min: 72, max: 280 },
  after: { min: 56, max: 220 },
  who: { min: 64, max: 280 },
};

/** Left to right, as the table draws them. */
export function columnsFor(show: ColumnShow): ColumnKey[] {
  return [
    'row', 'code', ...(show.wbs ? ['wbs' as const] : []), 'name', 'env', 'days',
    ...(show.estimates ? ['best' as const, 'worst' as const] : []),
    'after', ...(show.who ? ['who' as const] : []), 'start', 'finish', 'float', 'status',
  ];
}

export function clampWidth(key: ColumnKey, w: number): number {
  const r = RESIZABLE[key];
  if (!r) return DEFAULT_WIDTH[key];
  return Math.round(Math.min(r.max, Math.max(r.min, w)));
}

/**
 * The width that shows the widest of `needs` (each already the full pixel
 * width a cell asks for), clamped to the column's range. Nothing to measure
 * keeps the default.
 */
export function fitWidth(key: ColumnKey, needs: readonly number[]): number {
  if (!needs.length) return DEFAULT_WIDTH[key];
  return clampWidth(key, Math.max(...needs));
}

/** Hand widths over fitted ones over defaults, for the columns shown. */
export function resolveWidths(
  keys: readonly ColumnKey[],
  fitted: Partial<Record<ColumnKey, number>>,
  manual: Partial<Record<ColumnKey, number>>,
): Record<ColumnKey, number> {
  const out = {} as Record<ColumnKey, number>;
  for (const k of keys) {
    const m = manual[k];
    out[k] = RESIZABLE[k] && m != null ? clampWidth(k, m) : fitted[k] ?? DEFAULT_WIDTH[k];
  }
  return out;
}

export function totalWidth(keys: readonly ColumnKey[], widths: Record<ColumnKey, number>): number {
  return keys.reduce((sum, k) => sum + widths[k], 0);
}

/** Reads remembered hand widths, dropping anything that is not a resizable column's number. */
export function parseManualWidths(raw: string | null): Partial<Record<ColumnKey, number>> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== 'object') return {};
    const out: Partial<Record<ColumnKey, number>> = {};
    for (const [k, w] of Object.entries(v as Record<string, unknown>)) {
      if (k in RESIZABLE && typeof w === 'number' && Number.isFinite(w)) out[k as ColumnKey] = clampWidth(k as ColumnKey, w);
    }
    return out;
  } catch {
    return {};
  }
}
