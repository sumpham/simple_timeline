import type { Task } from './types.ts';

/**
 * The plan's outline: summary tasks and the tasks under them.
 *
 * `sort_order` only orders siblings; the outline is always read depth-first, so
 * a summary's tasks follow it by construction and no ordering mistake can split
 * a summary from its children. A parent that is missing (or a loop, which the
 * server refuses) is treated as top level rather than hiding the task.
 */

type Node = Pick<Task, 'id' | 'sort_order'> & { parent_id?: number | null };

export type OutlineRow = {
  id: number;
  depth: number;
  /** 1, 1.1, 1.2, 2 … */
  wbs: string;
  /** Has children, so it is a summary. */
  summary: boolean;
  parent_id: number | null;
};

/** How deep an outline may go; deeper than this is a mistake, not a plan. */
export const MAX_DEPTH = 8;

export function parentOf(tasks: readonly Node[]): Map<number, number | null> {
  const ids = new Set(tasks.map((t) => t.id));
  const out = new Map<number, number | null>();
  for (const t of tasks) out.set(t.id, t.parent_id != null && ids.has(t.parent_id) && t.parent_id !== t.id ? t.parent_id : null);
  // Break any loop: a task whose chain of parents never reaches the top goes to the top.
  for (const t of tasks) {
    const seen = new Set<number>([t.id]);
    let cur = out.get(t.id) ?? null;
    let guard = 0;
    while (cur != null && guard++ < tasks.length + 1) {
      if (seen.has(cur)) { out.set(t.id, null); break; }
      seen.add(cur);
      cur = out.get(cur) ?? null;
    }
  }
  return out;
}

/** Tasks in outline order, depth-first, siblings by `sort_order` then id. */
export function outline(tasks: readonly Node[]): OutlineRow[] {
  const parent = parentOf(tasks);
  const kids = new Map<number | null, Node[]>();
  for (const t of tasks) {
    const p = parent.get(t.id) ?? null;
    (kids.get(p) ?? kids.set(p, []).get(p)!).push(t);
  }
  for (const list of kids.values()) list.sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  const rows: OutlineRow[] = [];
  const walk = (p: number | null, depth: number, prefix: string) => {
    (kids.get(p) ?? []).forEach((t, i) => {
      const wbs = prefix ? `${prefix}.${i + 1}` : String(i + 1);
      rows.push({ id: t.id, depth, wbs, summary: (kids.get(t.id)?.length ?? 0) > 0, parent_id: p });
      if (depth < 64) walk(t.id, depth + 1, wbs);
    });
  };
  walk(null, 0, '');
  return rows;
}

/** Tasks sorted into outline order, for everything that numbers rows. */
export function inOutlineOrder<T extends Node>(tasks: readonly T[]): T[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return outline(tasks).map((r) => byId.get(r.id)!);
}

export function summaryIds(tasks: readonly Node[]): Set<number> {
  const parent = parentOf(tasks);
  return new Set([...parent.values()].filter((p): p is number => p != null));
}

/** Every task under `id`, at any depth. */
export function descendants(tasks: readonly Node[], id: number): Set<number> {
  const parent = parentOf(tasks);
  const out = new Set<number>();
  let grew = true;
  let guard = 0;
  while (grew && guard++ < tasks.length + 1) {
    grew = false;
    for (const [child, p] of parent) {
      if (p != null && (p === id || out.has(p)) && !out.has(child)) { out.add(child); grew = true; }
    }
  }
  return out;
}

/** The tasks under `id` that do the work: its descendants that are not summaries themselves. */
export function leavesOf(tasks: readonly Node[], id: number): number[] {
  const summaries = summaryIds(tasks);
  return [...descendants(tasks, id)].filter((d) => !summaries.has(d));
}

export function depthOf(tasks: readonly Node[], id: number): number {
  const parent = parentOf(tasks);
  let d = 0;
  let cur = parent.get(id) ?? null;
  while (cur != null && d < 64) { d++; cur = parent.get(cur) ?? null; }
  return d;
}

export type OutlinePlacement = { id: number; parent_id: number | null; sort_order: number };

/**
 * Indent: the task goes under the sibling just above it, as that sibling's last
 * child. Null when there is no sibling above, or it would go too deep.
 */
export function indent(tasks: readonly Node[], id: number): OutlinePlacement[] | null {
  const rows = outline(tasks);
  const me = rows.find((r) => r.id === id);
  if (!me) return null;
  const siblings = rows.filter((r) => r.parent_id === me.parent_id);
  const i = siblings.findIndex((r) => r.id === id);
  if (i <= 0) return null;
  const newParent = siblings[i - 1].id;
  if (me.depth + 1 >= MAX_DEPTH) return null;
  const kids = rows.filter((r) => r.parent_id === newParent);
  return renumber([...kids.map((r) => r.id), id], newParent);
}

/**
 * Outdent: the task leaves its summary and follows it as the next sibling. The
 * tasks that came after it under the old summary stay there, so nothing else moves.
 */
export function outdent(tasks: readonly Node[], id: number): OutlinePlacement[] | null {
  const rows = outline(tasks);
  const me = rows.find((r) => r.id === id);
  if (!me || me.parent_id == null) return null;
  const parent = rows.find((r) => r.id === me.parent_id)!;
  const oldSiblings = rows.filter((r) => r.parent_id === me.parent_id && r.id !== id).map((r) => r.id);
  const newSiblings = rows.filter((r) => r.parent_id === parent.parent_id).map((r) => r.id);
  newSiblings.splice(newSiblings.indexOf(parent.id) + 1, 0, id);
  return [...renumber(newSiblings, parent.parent_id), ...renumber(oldSiblings, me.parent_id)];
}

/** Swap a task (with everything under it) with its neighbour among its siblings. */
export function moveAmongSiblings(tasks: readonly Node[], id: number, delta: -1 | 1): OutlinePlacement[] | null {
  const rows = outline(tasks);
  const me = rows.find((r) => r.id === id);
  if (!me) return null;
  const siblings = rows.filter((r) => r.parent_id === me.parent_id).map((r) => r.id);
  const i = siblings.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= siblings.length) return null;
  [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
  return renumber(siblings, me.parent_id);
}

/**
 * A dragged row dropped just above `beforeId` (null: below the last row). The task
 * and everything under it join `beforeId`'s level, just before it, so dropping on
 * a summary's first child puts it under that summary. Null when nothing would
 * move, when the drop lands inside the task's own lines, or when it goes too deep.
 */
export function moveBefore(tasks: readonly Node[], id: number, beforeId: number | null): OutlinePlacement[] | null {
  const rows = outline(tasks);
  const me = rows.find((r) => r.id === id);
  if (!me || beforeId === id) return null;
  const under = descendants(tasks, id);
  if (beforeId != null && under.has(beforeId)) return null;
  const target = beforeId != null ? rows.find((r) => r.id === beforeId) : null;
  if (beforeId != null && !target) return null;
  const parent = target ? target.parent_id : null;

  const depth = target ? target.depth : 0;
  const deepest = Math.max(0, ...rows.filter((r) => under.has(r.id)).map((r) => r.depth - me.depth));
  if (depth + deepest >= MAX_DEPTH) return null;

  const siblings = rows.filter((r) => r.parent_id === parent && r.id !== id).map((r) => r.id);
  siblings.splice(target ? siblings.indexOf(target.id) : siblings.length, 0, id);
  if (parent === me.parent_id) {
    const was = rows.filter((r) => r.parent_id === parent).map((r) => r.id);
    if (was.every((x, i) => x === siblings[i])) return null;
    return renumber(siblings, parent);
  }
  const left = rows.filter((r) => r.parent_id === me.parent_id && r.id !== id).map((r) => r.id);
  return [...renumber(siblings, parent), ...renumber(left, me.parent_id)];
}

function renumber(ids: number[], parent: number | null): OutlinePlacement[] {
  return ids.map((id, i) => ({ id, parent_id: parent, sort_order: i }));
}
