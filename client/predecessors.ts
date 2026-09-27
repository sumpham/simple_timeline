import type { TaskDependency } from '../shared/types.ts';

/**
 * The "After" column: predecessors written as row numbers, with an optional lag,
 * the way scheduling tools have always taken them. `2` waits for row 2, `2+3`
 * starts three working days after it ends, `2-1` overlaps it by a day.
 */

export type ParsedPredecessors =
  | { ok: true; rows: { row: number; lag: number }[] }
  | { ok: false; error: string };

export function parsePredecessors(text: string, rowCount: number, ownRow: number): ParsedPredecessors {
  const rows: { row: number; lag: number }[] = [];
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  for (const part of parts) {
    const m = /^(\d+)(?:([+-])(\d+)d?)?$/i.exec(part);
    if (!m) return { ok: false, error: `“${part}” is not a row number. Write 2, or 2+3 for a three-day lag.` };
    const row = Number(m[1]);
    if (row < 1 || row > rowCount) return { ok: false, error: `There is no row ${row}.` };
    if (row === ownRow) return { ok: false, error: 'A task cannot come after itself.' };
    const lag = m[2] ? (m[2] === '-' ? -1 : 1) * Number(m[3]) : 0;
    if (!rows.some((r) => r.row === row)) rows.push({ row, lag });
  }
  return { ok: true, rows };
}

/** One task's predecessors back into the column's notation, in row order. */
export function formatPredecessors(
  deps: readonly TaskDependency[],
  taskId: number,
  rowOf: ReadonlyMap<number, number>,
): string {
  return deps
    .filter((d) => d.successor_id === taskId && rowOf.has(d.predecessor_id))
    .map((d) => ({ row: rowOf.get(d.predecessor_id)!, lag: d.lag }))
    .sort((a, b) => a.row - b.row)
    .map(({ row, lag }) => (lag ? `${row}${lag > 0 ? '+' : ''}${lag}` : String(row)))
    .join(', ');
}
