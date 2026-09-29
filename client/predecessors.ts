import type { LinkType, TaskDependency } from '../shared/types.ts';

/**
 * The "After" column: predecessors written as row numbers, with an optional link
 * type and lag, the way scheduling tools have always taken them. `2` waits for
 * row 2 to finish, `2+3` starts three working days after it ends, `2-1` overlaps
 * it by a day, `2SS` starts when row 2 starts, `2FF+1` finishes a day after it.
 */

export type PredecessorRow = { row: number; lag: number; type: LinkType };

export type ParsedPredecessors =
  | { ok: true; rows: PredecessorRow[] }
  | { ok: false; error: string };

export function parsePredecessors(text: string, rowCount: number, ownRow: number): ParsedPredecessors {
  const rows: PredecessorRow[] = [];
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  for (const part of parts) {
    const m = /^(\d+)(FS|SS|FF)?(?:([+-])(\d+)d?)?$/i.exec(part);
    if (!m) return { ok: false, error: `“${part}” is not a row number. Write 2, 2+3 for a three-day lag, or 2SS / 2FF.` };
    const row = Number(m[1]);
    if (row < 1 || row > rowCount) return { ok: false, error: `There is no row ${row}.` };
    if (row === ownRow) return { ok: false, error: 'A task cannot come after itself.' };
    const lag = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
    const type = (m[2]?.toUpperCase() ?? 'FS') as LinkType;
    if (!rows.some((r) => r.row === row)) rows.push({ row, lag, type });
  }
  return { ok: true, rows };
}

/** One link in the column's notation: FS is the default and is left unsaid. */
export function formatLink(row: number, lag: number, type: LinkType | null | undefined): string {
  const t = type && type !== 'FS' ? type : '';
  return `${row}${t}${lag ? `${lag > 0 ? '+' : ''}${lag}` : ''}`;
}

/** One task's predecessors back into the column's notation, in row order. */
export function formatPredecessors(
  deps: readonly TaskDependency[],
  taskId: number,
  rowOf: ReadonlyMap<number, number>,
): string {
  return deps
    .filter((d) => d.successor_id === taskId && rowOf.has(d.predecessor_id))
    .map((d) => ({ row: rowOf.get(d.predecessor_id)!, lag: d.lag, type: d.type }))
    .sort((a, b) => a.row - b.row)
    .map(({ row, lag, type }) => formatLink(row, lag, type))
    .join(', ');
}
