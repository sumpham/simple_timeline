import { addWorkingDays, snapToWorkingDay, type HolidaySet } from './dates.ts';
import { scheduleProject } from './schedule.ts';
import type { ISODate, LinkType, Task, TaskDependency } from './types.ts';

/**
 * Links between projects (reqs/pm_features.md §7): a task in one project
 * drives a task in another. Pure, shared by the server's replan and preview and
 * by the browser, so a prediction and a save agree.
 *
 * A link is forward only: it becomes a floor ("start no earlier than") on its
 * successor, worked out from the predecessor's scheduled dates and the link's
 * type and lag in working days, the same meaning a link inside a plan has. The
 * floor is never written into `not_before`; it is recomputed on every replan.
 */

export type ProjectLink = {
  id: number;
  predecessor_id: number;
  successor_id: number;
  type: LinkType;
  lag: number;
};

/** The earliest start a link allows its successor, from the predecessor's span. */
export function linkFloor(
  link: Pick<ProjectLink, 'type' | 'lag'>,
  pred: { start: ISODate; end: ISODate },
  successorDuration: number,
  holidays?: HolidaySet,
): ISODate {
  if (link.type === 'SS') return addWorkingDays(snapToWorkingDay(pred.start, holidays), link.lag, holidays);
  // A finish (a milestone's too) is the end of its day; the next working day is the
  // first a successor can use, exactly as scheduleProject reads a link inside a plan.
  const after = addWorkingDays(pred.end, 1, holidays);
  if (link.type === 'FF') return addWorkingDays(after, link.lag - Math.max(0, successorDuration), holidays);
  return addWorkingDays(after, link.lag, holidays);
}

/** Every successor's floor from its incoming links: the latest of them. */
export function externalFloors(
  links: readonly (Pick<ProjectLink, 'type' | 'lag' | 'successor_id'> & { pred: { start: ISODate; end: ISODate } | null })[],
  durationOf: (taskId: number) => number,
  holidays?: HolidaySet,
): Map<number, ISODate> {
  const out = new Map<number, ISODate>();
  for (const l of links) {
    if (!l.pred) continue;
    const f = linkFloor(l, l.pred, durationOf(l.successor_id), holidays);
    const was = out.get(l.successor_id);
    if (!was || f > was) out.set(l.successor_id, f);
  }
  return out;
}

/**
 * Projects in the order a change must replan them: each after every project it
 * waits on. A loop between projects is refused, naming it. One step per edge at
 * most, so it always ends.
 */
export function projectOrder(projects: readonly number[], edges: readonly (readonly [from: number, to: number])[]): { order: number[] } | { cycle: number[] } {
  const ids = [...new Set([...projects, ...edges.flat()])];
  const out = new Map<number, Set<number>>(ids.map((id) => [id, new Set()]));
  const indegree = new Map<number, number>(ids.map((id) => [id, 0]));
  for (const [a, b] of edges) {
    if (a === b || out.get(a)!.has(b)) continue;
    out.get(a)!.add(b);
    indegree.set(b, indegree.get(b)! + 1);
  }
  const ready = ids.filter((id) => indegree.get(id) === 0).sort((a, b) => a - b);
  const order: number[] = [];
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const n of out.get(id)!) {
      indegree.set(n, indegree.get(n)! - 1);
      if (indegree.get(n) === 0) ready.push(n);
    }
  }
  if (order.length === ids.length) return { order };
  return { cycle: findCycle(ids.filter((id) => indegree.get(id)! > 0), out) };
}

function findCycle(left: readonly number[], out: ReadonlyMap<number, ReadonlySet<number>>): number[] {
  const inLeft = new Set(left);
  const start = left[0];
  const path: number[] = [start];
  const seen = new Map<number, number>([[start, 0]]);
  for (let cur = start, guard = 0; guard <= left.length; guard++) {
    const next = [...out.get(cur)!].find((n) => inLeft.has(n))!;
    if (seen.has(next)) return [...path.slice(seen.get(next)!), next];
    seen.set(next, path.length);
    path.push(next);
    cur = next;
  }
  return path;
}

/** Every project reachable downstream of `from` through the edges, in replan order (not `from` itself). */
export function downstreamOf(from: number, order: readonly number[], edges: readonly (readonly [number, number])[]): number[] {
  const reach = new Set<number>([from]);
  for (const id of order) {
    if (!reach.has(id)) continue;
    for (const [a, b] of edges) if (a === id) reach.add(b);
  }
  return order.filter((id) => id !== from && reach.has(id));
}

/**
 * The short tag After uses for a project: its first word when no other project
 * of the team starts with that word, else its name without spaces.
 */
export function projectTags(projects: readonly { id: number; name: string }[]): Map<number, string> {
  const word = (n: string) => n.trim().split(/\s+/)[0] ?? '';
  const out = new Map<number, string>();
  for (const p of projects) {
    const w = word(p.name);
    const clash = projects.some((o) => o.id !== p.id && word(o.name).toLowerCase() === w.toLowerCase());
    out.set(p.id, (clash ? p.name.replace(/\s+/g, '') : w).replace(/[:,;]/g, ''));
  }
  return out;
}

export type ExternalRef = { project_id: number; code: number; type: LinkType; lag: number };

const EXTERNAL = /^([^\s,;:]+):(\d+)(FS|SS|FF)?(?:([+-])(\d+)d?)?$/i;

/** Whether an After token names another project's task (`Refund:12`, `Refund:12SS+2`). */
export const isExternalToken = (token: string) => token.includes(':');

/**
 * Read an After token that names another project's task. The tag matches a
 * project's tag, or uniquely the start of a project's name without spaces.
 */
export function parseExternal(
  token: string,
  projects: readonly { id: number; name: string }[],
  ownProject: number,
): { ok: true; ref: ExternalRef } | { ok: false; error: string } {
  const m = EXTERNAL.exec(token.trim());
  if (!m) return { ok: false, error: `“${token}” is not a task in another plan. Write the plan’s name, a colon and the task ID, like Refund:12.` };
  const tag = m[1].toLowerCase();
  const tags = projectTags(projects);
  const others = projects.filter((p) => p.id !== ownProject);
  let hit = others.filter((p) => tags.get(p.id)!.toLowerCase() === tag);
  if (!hit.length) hit = others.filter((p) => p.name.replace(/\s+/g, '').toLowerCase().startsWith(tag));
  if (!hit.length) return { ok: false, error: `No other plan in this team is called “${m[1]}”.` };
  if (hit.length > 1) return { ok: false, error: `“${m[1]}” could be ${hit.map((p) => p.name).join(' or ')}. Write more of the name.` };
  const lag = m[4] ? (m[4] === '-' ? -1 : 1) * Number(m[5]) : 0;
  return { ok: true, ref: { project_id: hit[0].id, code: Number(m[2]), type: (m[3]?.toUpperCase() ?? 'FS') as LinkType, lag } };
}

/** An external link as After writes it: `Refund:12`, with its type and lag when they are not plain FS. */
export function formatExternal(tag: string, code: number | null, type: LinkType, lag: number): string {
  return `${tag}:${code ?? '?'}${type !== 'FS' ? type : ''}${lag ? `${lag > 0 ? '+' : '-'}${Math.abs(lag)}` : ''}`;
}

export type PortfolioProject = {
  id: number;
  start: ISODate;
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
};

/**
 * The team's plans as one network, for the portfolio's critical path across
 * projects: every plan's tasks and links, the links between plans as ordinary
 * links, and each plan held to its own start. Read-only and never stored; the
 * tasks it marks are the ones that drive the latest finish of all.
 */
export function portfolioCritical(
  projects: readonly PortfolioProject[],
  links: readonly ProjectLink[],
  holidays?: HolidaySet,
): { critical: Set<number>; links: Set<number> } | { cycle: number[] } {
  if (!projects.length) return { critical: new Set(), links: new Set() };
  const start = projects.reduce((m, p) => (p.start < m ? p.start : m), projects[0].start);
  const tasks = projects.flatMap((p) => p.tasks.map((t) => ({ ...t, not_before: t.not_before && t.not_before > p.start ? t.not_before : p.start })));
  const deps = [...projects.flatMap((p) => p.deps), ...links.map((l) => ({ predecessor_id: l.predecessor_id, successor_id: l.successor_id, lag: l.lag, type: l.type }))];
  const r = scheduleProject({ tasks, deps, projectStart: start, holidays });
  if ('cycle' in r) return r;
  const critical = new Set([...r.tasks.values()].filter((s) => s.critical && !s.summary).map((s) => s.id));
  return { critical, links: new Set(links.filter((l) => critical.has(l.predecessor_id) && critical.has(l.successor_id)).map((l) => l.id)) };
}
