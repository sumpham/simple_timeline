import type { LinkType, TaskDependency } from '../shared/types.ts';

/**
 * The "After" column: predecessors written as TaskIDs, with an optional link
 * type and lag, the way scheduling tools have always taken them. `2` waits for
 * task 2 to finish, `2+3` starts three working days after it ends, `2-1` overlaps
 * it by a day, `2SS` starts when task 2 starts, `2FF+1` finishes a day after it.
 * Files still refer to their own rows, so the row form stays for imports.
 */

export type PredecessorRow = { row: number; lag: number; type: LinkType };

export type ParsedPredecessors =
  | { ok: true; rows: PredecessorRow[] }
  | { ok: false; error: string };

const LINK = /^(\d+)(FS|SS|FF)?(?:([+-])(\d+)d?)?$/i;

/** Split the column into links, checking each number with `check` (an error, or null when it is fine). */
function parseLinks(text: string, what: string, check: (n: number) => string | null): ParsedPredecessors {
  const rows: PredecessorRow[] = [];
  const parts = text.split(/[,;\s]+/).filter(Boolean);
  for (const part of parts) {
    const m = LINK.exec(part);
    if (!m) return { ok: false, error: `“${part}” is not ${what}. Write 2, 2+3 for a three-day lag, or 2SS / 2FF.` };
    const row = Number(m[1]);
    const error = check(row);
    if (error) return { ok: false, error };
    const lag = m[3] ? (m[3] === '-' ? -1 : 1) * Number(m[4]) : 0;
    const type = (m[2]?.toUpperCase() ?? 'FS') as LinkType;
    if (!rows.some((r) => r.row === row)) rows.push({ row, lag, type });
  }
  return { ok: true, rows };
}

/** Links by row number (1-based position), as files write them. */
export function parsePredecessors(text: string, rowCount: number, ownRow: number): ParsedPredecessors {
  return parseLinks(text, 'a row number', (row) => (row < 1 || row > rowCount ? `There is no row ${row}.`
    : row === ownRow ? 'A task cannot come after itself.' : null));
}

export type AfterLink = { id: number; lag: number; type: LinkType };

/** Links by TaskID, as the table and the task dialog take them. `idOfCode` maps TaskID to task id. */
export function parseAfter(
  text: string,
  idOfCode: ReadonlyMap<number, number>,
  ownId: number,
): { ok: true; links: AfterLink[] } | { ok: false; error: string } {
  const parsed = parseLinks(text, 'a task ID', (code) => (!idOfCode.has(code) ? `There is no task with ID ${code}.`
    : idOfCode.get(code) === ownId ? 'A task cannot come after itself.' : null));
  if (!parsed.ok) return parsed;
  return { ok: true, links: parsed.rows.map((r) => ({ id: idOfCode.get(r.row)!, lag: r.lag, type: r.type })) };
}

export type AfterSuggestion = { code: number; name: string };

/**
 * What to offer while someone types in After: the word under the caret, read as
 * the start of a TaskID or a piece of a task's name. The task itself and tasks
 * already listed are left out. `from`/`to` bound the part a pick replaces: the
 * ID only, so a typed type or lag (`SS+2`) stays.
 */
export function afterSuggestions(
  text: string,
  caret: number,
  tasks: readonly { id: number; code: number; name: string }[],
  ownId: number,
  limit = 8,
): { from: number; to: number; items: AfterSuggestion[] } {
  const from = text.slice(0, caret).search(/[^,;\s]*$/);
  const word = text.slice(from).match(/^[^,;\s]*/)![0];
  // A number keeps its type and lag; anything else is a name to look for.
  const token = /^\d/.test(word) ? word.match(/^\d*/)![0] : word;
  const listed = new Set(
    (text.slice(0, from) + ' ' + text.slice(from + word.length)).split(/[,;\s]+/)
      .map((p) => LINK.exec(p)).filter((m): m is RegExpExecArray => !!m).map((m) => Number(m[1])),
  );
  const q = token.toLowerCase();
  const items = tasks
    .filter((t) => t.id !== ownId && !listed.has(t.code))
    .filter((t) => !q || (/^\d+$/.test(q) ? String(t.code).startsWith(q) : t.name.toLowerCase().includes(q)))
    .sort((a, b) => a.code - b.code)
    .slice(0, limit)
    .map((t) => ({ code: t.code, name: t.name }));
  return { from, to: from + token.length, items };
}

/** Put a picked TaskID in place of the word it was chosen for; the caret lands after it. */
export function applySuggestion(text: string, from: number, to: number, code: number): { text: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to);
  const id = String(code);
  return { text: before + id + after, caret: before.length + id.length };
}

/** One link in the column's notation: FS is the default and is left unsaid. */
export function formatLink(row: number, lag: number, type: LinkType | null | undefined): string {
  const t = type && type !== 'FS' ? type : '';
  return `${row}${t}${lag ? `${lag > 0 ? '+' : ''}${lag}` : ''}`;
}

/** One task's predecessors back into the column's notation, in order; `rowOf` maps task id to its TaskID or row. */
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
