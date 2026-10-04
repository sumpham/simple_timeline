import { addDays, snapToWorkingDay, workingDays } from '../dates.ts';
import type { BookingView, Environment, ISODate, LinkType, Task, TaskDependency } from '../types.ts';
import type { PlanFacts, TaskFacts } from './facts.ts';
import { day, label } from './rules.ts';

/**
 * The moves the assistant can propose (reqs/smart_assistant.md §4.3), each as a
 * list of the plan's ordinary change ops. A move never writes: it is previewed
 * and applied through the same path as a hand edit, so replan runs and every
 * rule a save checks is checked.
 */

/**
 * M1–M7 are the engine's own moves (§4.3); MA is one an LLM advisor proposed and
 * the engine kept. ML levels a person within float; MLX does it beyond float, at
 * a cost to the finish (reqs/pm_features.md §5).
 */
export type MoveKind = 'M1' | 'M2' | 'M3' | 'M4' | 'M5' | 'M6' | 'M7' | 'MA' | 'ML' | 'MLX';

export type OpFields = Partial<Pick<Task, 'name' | 'duration' | 'not_before' | 'environment_id'>>
  & { predecessors?: { id: number; lag: number; type: LinkType }[] };

/** A change op, the same shape the task routes take. `-1` names a task created earlier in the same list. */
export type PlanOp =
  | { op: 'update'; id: number; fields: OpFields }
  | { op: 'create'; fields: OpFields & { name: string }; after_id: number | null }
  | { op: 'delete'; id: number };

export const CREATED_ID = -1;

export type Move = {
  kind: MoveKind;
  /** Identity inside one search, so a path never makes the same move twice. */
  key: string;
  title: string;
  /** Why, in engine numbers. */
  reason: string;
  /** What it costs or risks; null for the safe moves. */
  tradeoff: string | null;
  ops: PlanOp[];
  task_ids: number[];
};

/** How much a move disturbs the plan, for the last tie-break: level first, crash last. */
export const DISRUPTION: Record<MoveKind, number> = { M1: 1, ML: 2, M5: 2, M4: 3, M2: 4, MA: 5, M3: 6, MLX: 6, M7: 7, M6: 8 };

export const MOVE_TITLE: Record<MoveKind, string> = {
  M1: 'Level within float',
  M2: 'Switch environment',
  M3: 'Fast-track',
  M4: 'Remove a driving date',
  M5: 'Drop a redundant link',
  M6: 'Crash',
  M7: 'Split a long task',
  MA: 'Advisor’s move',
  ML: 'Level a person',
  MLX: 'Level a person, moving the finish',
};

export type MoveContext = {
  facts: PlanFacts;
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
  /** The team's environments, for switching. */
  environments: readonly Environment[];
  /** The team's bookings as this state leaves them, for where a clash ends. */
  bookings: readonly BookingView[];
  longTaskDays: number;
  holidays?: ReadonlySet<ISODate>;
  /** People's names, for the words of a levelling move. */
  names?: ReadonlyMap<number, string>;
};

const unstarted = (t: TaskFacts) => !t.summary && (t.status === 'todo' || t.status === 'blocked');
const wd = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;

/** A task's links as the task routes take them: every predecessor, with its type and lag. */
export function predecessorsOf(deps: readonly TaskDependency[], id: number): { id: number; lag: number; type: LinkType }[] {
  return deps.filter((d) => d.successor_id === id).map((d) => ({ id: d.predecessor_id, lag: d.lag, type: d.type ?? 'FS' }));
}

// ---------------------------------------------------------------- M1, M2: clashes

/** M1: start a clashing task after the other booking ends, if its float absorbs the move. */
function levelWithinFloat(c: MoveContext): Move[] {
  const out: Move[] = [];
  for (const cl of c.facts.clashes) {
    const others = c.bookings.filter((b) => cl.conflict.booking_ids.includes(b.id) && b.project_id !== c.facts.project.id);
    if (!others.length) continue;
    const freeFrom = snapToWorkingDay(addDays(others.reduce((m, b) => (b.end_date > m ? b.end_date : m), others[0].end_date), 1), c.holidays);
    for (const id of cl.task_ids) {
      const t = c.facts.byId.get(id)!;
      if (!unstarted(t) || freeFrom <= t.start) continue;
      const shift = workingDays(t.start, addDays(freeFrom, -1), c.holidays);
      if (shift > t.total_float) continue;
      out.push({
        kind: 'M1',
        key: `M1:${id}:${freeFrom}`,
        title: `Start ${label(t)} on ${day(freeFrom)}`,
        reason: `${cl.conflict.env_name} is double-booked ${day(cl.conflict.start_date)} – ${day(cl.conflict.end_date)} with ${cl.others.map((p) => p.name).join(', ')}. `
          + `Starting after ${others.length === 1 ? 'that booking' : 'those bookings'} end${others.length === 1 ? 's' : ''} moves it ${wd(shift)}, inside its ${wd(t.total_float)} of float, so the finish holds.`,
        tradeoff: null,
        ops: [{ op: 'update', id, fields: { not_before: freeFrom } }],
        task_ids: [id],
      });
    }
  }
  return out;
}

/** M2: move clashing work to another environment of the same kind, one task or the whole clash at once. */
function switchEnvironment(c: MoveContext): Move[] {
  const out: Move[] = [];
  for (const cl of c.facts.clashes) {
    const env = c.environments.find((e) => e.id === cl.conflict.environment_id);
    if (!env) continue;
    const alternatives = c.environments.filter((e) => e.id !== env.id && e.kind === env.kind && e.team_id === env.team_id);
    const movable = cl.task_ids.map((id) => c.facts.byId.get(id)!).filter(unstarted);
    if (!movable.length) continue;
    for (const alt of alternatives) {
      const groups = movable.length > 1 ? [movable, ...movable.map((t) => [t])] : [movable];
      for (const g of groups) {
        out.push({
          kind: 'M2',
          key: `M2:${g.map((t) => t.id).join(',')}:${alt.id}`,
          title: `Move ${g.length === 1 ? label(g[0]) : `${g.length} tasks`} from ${env.name} to ${alt.name}`,
          reason: `${env.name} is double-booked ${day(cl.conflict.start_date)} – ${day(cl.conflict.end_date)} with ${cl.others.map((p) => p.name).join(', ')}; `
            + `${alt.name} is the same kind of environment.`,
          tradeoff: `Check ${alt.name} is set up for this work.`,
          ops: g.map((t) => ({ op: 'update' as const, id: t.id, fields: { environment_id: alt.id } })),
          task_ids: g.map((t) => t.id),
        });
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- M4: driving dates

function removeDrivingDate(c: MoveContext): Move[] {
  return c.facts.tasks
    .filter((t) => unstarted(t) && t.driven_by_constraint && (t.critical || t.near_critical))
    .filter((t) => c.tasks.find((x) => x.id === t.id)?.not_before)
    .map((t) => {
      const note = c.tasks.find((x) => x.id === t.id)?.note;
      return {
        kind: 'M4' as const,
        key: `M4:${t.id}`,
        title: `Clear ${label(t)}’s start-no-earlier-than ${day(t.not_before!)}`,
        reason: `The date holds ${label(t)} later than its links would, on the ${t.critical ? 'critical path' : 'near-critical path'}.`,
        tradeoff: `The date may be there for a reason (a delivery, a sign-off)${note ? `; its note says “${note.slice(0, 80)}”` : ''}. Clear it only if the reason has gone.`,
        ops: [{ op: 'update' as const, id: t.id, fields: { not_before: null } }],
        task_ids: [t.id],
      };
    });
}

// ---------------------------------------------------------------- M3, M6, M7: compression

/** M3: overlap a critical successor with its predecessor, a quarter or a half of the way through. */
function fastTrack(c: MoveContext): Move[] {
  const out: Move[] = [];
  for (const b of c.facts.tasks) {
    if (!unstarted(b) || !b.critical) continue;
    const preds = predecessorsOf(c.deps, b.id);
    for (const p of preds) {
      const a = c.facts.byId.get(p.id);
      if (!a || a.summary || !a.critical || a.status === 'done' || p.type !== 'FS' || p.lag < 0 || a.duration < 2) continue;
      for (const share of [0.25, 0.5]) {
        const overlap = Math.max(1, Math.floor(a.duration * share));
        const lag = a.duration - overlap + p.lag;
        out.push({
          kind: 'M3',
          key: `M3:${a.id}>${b.id}:${share}`,
          title: `Start ${label(b)} ${wd(overlap)} before ${label(a)} ends`,
          reason: `Both are critical. Overlapping them (start-to-start, +${lag}) takes up to ${wd(overlap)} off the path.`,
          tradeoff: `Work starts on unfinished input: expect rework if ${label(a)} changes late.`,
          ops: [{ op: 'update', id: b.id, fields: { predecessors: preds.map((x) => (x.id === a.id ? { id: a.id, lag, type: 'SS' as const } : x)) } }],
          task_ids: [a.id, b.id],
        });
      }
    }
  }
  return out;
}

/** M6: shorten a critical task by about a fifth, by adding people. Never below its best case. */
function crash(c: MoveContext): Move[] {
  const out: Move[] = [];
  for (const t of c.facts.tasks) {
    if (!unstarted(t) || !t.critical || t.duration < 3) continue;
    const raw = c.tasks.find((x) => x.id === t.id);
    const floor = raw?.duration_low ?? 1;
    const next = Math.max(floor, t.duration - Math.max(1, Math.round(t.duration * 0.2)));
    if (next >= t.duration) continue;
    const people = Math.max(1, t.people.length);
    const extra = (t.duration - next) * people;
    out.push({
      kind: 'M6',
      key: `M6:${t.id}`,
      title: `Crash ${label(t)} from ${t.duration} to ${next} days`,
      reason: `It is critical, so each day off it can come off the finish.`,
      tradeoff: `Needs about ${extra} more person-day${extra === 1 ? '' : 's'} of capacity in the same window. New people on a task slow it down at first.`,
      ops: [{ op: 'update', id: t.id, fields: { duration: next } }],
      task_ids: [t.id],
    });
  }
  return out;
}

/** M7: split a long critical task so what follows can start on its first part. */
function split(c: MoveContext): Move[] {
  const out: Move[] = [];
  for (const t of c.facts.tasks) {
    if (!unstarted(t) || !t.critical || t.duration <= c.longTaskDays || !t.succs.length) continue;
    const first = Math.ceil(t.duration / 2);
    out.push({
      kind: 'M7',
      key: `M7:${t.id}`,
      title: `Split ${label(t)} into ${first} + ${t.duration - first} days`,
      reason: `At ${wd(t.duration)} it is longer than ${wd(c.longTaskDays)}. What follows it would wait only for the first part.`,
      tradeoff: `Assumes the tasks after it need only the first part. Name the parts, and put people on part 2.`,
      ops: [
        { op: 'update', id: t.id, fields: { duration: first, name: `${t.name} (part 1)`.slice(0, 200) } },
        {
          op: 'create',
          fields: {
            name: `${t.name} (part 2)`.slice(0, 200), duration: t.duration - first, environment_id: t.environment_id,
            predecessors: [{ id: t.id, lag: 0, type: 'FS' }],
          },
          after_id: t.id,
        },
      ],
      task_ids: [t.id],
    });
  }
  return out;
}

// ---------------------------------------------------------------- M5: tidy-ups

/**
 * M5: a finish-to-start link already implied by another chain of finish-to-start
 * links with no leads (A→B→C makes A→C redundant). Dropping it moves no date;
 * it takes a path out of a merge. Bounded: one walk per link.
 */
export function redundantLinks(c: MoveContext): Move[] {
  const byPred = new Map<number, TaskDependency[]>();
  for (const d of c.deps) (byPred.get(d.predecessor_id) ?? byPred.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d);
  const firm = (d: TaskDependency) => (d.type ?? 'FS') === 'FS' && d.lag >= 0;
  const out: Move[] = [];
  for (const d of c.deps) {
    if ((d.type ?? 'FS') !== 'FS' || d.lag > 0) continue;
    const a = c.facts.byId.get(d.predecessor_id);
    const b = c.facts.byId.get(d.successor_id);
    if (!a || !b || a.summary || b.summary) continue;
    // Is there another firm path from a to b, two links or longer?
    const seen = new Set<number>([a.id]);
    const queue = (byPred.get(a.id) ?? []).filter((x) => x !== d && firm(x)).map((x) => x.successor_id);
    let found = false;
    for (let guard = 0; queue.length && guard <= c.deps.length; guard++) {
      const id = queue.shift()!;
      if (id === b.id) { found = true; break; }
      if (seen.has(id)) continue;
      seen.add(id);
      for (const x of byPred.get(id) ?? []) if (firm(x)) queue.push(x.successor_id);
    }
    if (!found) continue;
    out.push({
      kind: 'M5',
      key: `M5:${a.id}>${b.id}`,
      title: `Drop the link ${label(a)} → ${label(b)}`,
      reason: `Another chain of links already holds ${label(b)} after ${label(a)}, so this one changes no date${b.preds.length >= 3 ? ` and only adds to the ${b.preds.length} paths meeting at ${label(b)}` : ''}.`,
      tradeoff: null,
      ops: [{ op: 'update', id: b.id, fields: { predecessors: predecessorsOf(c.deps, b.id).filter((p) => p.id !== a.id) } }],
      task_ids: [a.id, b.id],
    });
  }
  return out;
}

// ---------------------------------------------------------------- ML, MLX: people

/**
 * Level a person: when someone is on two tasks at once, start one of this plan's
 * unstarted tasks the working day after the other ends. Within its float it is
 * ML and the finish holds; beyond it, MLX, and the trade-off says so. The search
 * judges either like any move, so a levelling that makes a double-booking is
 * never kept.
 */
function levelPeople(c: MoveContext, within: boolean): Move[] {
  const out: Move[] = [];
  const seen = new Set<string>();
  for (const o of c.facts.overlaps) {
    const who = c.names?.get(o.resource_id) ?? 'Someone';
    for (const [id, otherId] of [[o.a, o.b], [o.b, o.a]] as const) {
      const t = c.facts.byId.get(id);
      const other = o.spans[otherId];
      if (!t || !unstarted(t) || !other?.end) continue;
      const freeFrom = snapToWorkingDay(addDays(other.end, 1), c.holidays);
      if (freeFrom <= t.start) continue;
      const shift = workingDays(t.start, addDays(freeFrom, -1), c.holidays);
      const fits = shift <= Math.max(0, t.total_float);
      if (fits !== within) continue;
      const key = `${within ? 'ML' : 'MLX'}:${id}:${freeFrom}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const otherName = other.here ? label({ name: other.name, code: other.code }) : `${other.name} in ${other.project_name ?? 'another plan'}`;
      out.push({
        kind: within ? 'ML' : 'MLX',
        key,
        title: `Start ${label(t)} on ${day(freeFrom)}`,
        reason: `${who} is on ${label(t)} and ${otherName} at once for ${wd(o.days)}, ${day(o.start)} – ${day(o.end)}. `
          + `Starting it after ${otherName} ends moves it ${wd(shift)}${fits ? `, inside its ${wd(Math.max(0, t.total_float))} of float, so the finish holds.` : '.'}`,
        tradeoff: fits ? null : `It has ${wd(Math.max(0, t.total_float))} of float, so the finish can move by up to ${wd(shift - Math.max(0, t.total_float))}.`,
        ops: [{ op: 'update', id, fields: { not_before: freeFrom } }],
        task_ids: [id],
      });
    }
  }
  return out;
}

export const GENERATORS: Record<Exclude<MoveKind, 'M5' | 'MA'>, (c: MoveContext) => Move[]> = {
  M1: levelWithinFloat,
  M2: switchEnvironment,
  M3: fastTrack,
  M4: removeDrivingDate,
  M6: crash,
  M7: split,
  ML: (c) => levelPeople(c, true),
  MLX: (c) => levelPeople(c, false),
};
