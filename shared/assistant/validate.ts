import { lateBy } from '../schedule.ts';
import type { ISODate } from '../types.ts';
import { dateAtOffset, unmaskText } from './digest.ts';
import type { OpFields, PlanOp } from './moves.ts';
import { createSearch, effectOf, type SearchContext, type Suggestion } from './optimise.ts';
import { seedOf } from './random.ts';
import { label } from './rules.ts';

/**
 * The advisor's answer, and the engine's verdict on it (reqs/smart_assistant.md
 * §6.1: the LLM advises, the engine decides). The model names tasks by code and
 * dates as working-day offsets; this turns its moves into the plan's change ops
 * and runs each through the same search the engine's own suggestions pass. A
 * move that a save would refuse, that makes a new double-booking, or that makes
 * the P80 later is dropped, with the reason kept for the log and the panel.
 */

export type AdvisorLink = { task: number; type?: 'FS' | 'SS' | 'FF'; lag?: number };
export type AdvisorChange = { duration?: number; not_before?: number | null; environment?: string; after?: AdvisorLink[] };
export type AdvisorMove = { task: number; change: AdvisorChange; why: string };
export type AdvisorAnswer = {
  briefing: string;
  risks: { key: string; rank: number; why: string }[];
  moves: AdvisorMove[];
};

export const BRIEFING_MAX = 900;
export const WHY_MAX = 300;
export const MOVES_MAX = 5;

const linkSchema = {
  type: 'object',
  properties: {
    task: { type: 'integer', description: 'Task code' },
    type: { type: 'string', enum: ['FS', 'SS', 'FF'] },
    lag: { type: 'integer', description: 'Working days; negative is a lead' },
  },
  required: ['task'],
  additionalProperties: false,
} as const;

const changeSchema = {
  type: 'object',
  description: 'Only the fields to change.',
  properties: {
    duration: { type: 'integer', minimum: 0 },
    not_before: { type: ['integer', 'null'], description: 'Start no earlier than, as a working-day offset from the status date; null clears it' },
    environment: { type: 'string', description: 'Environment name' },
    after: { type: 'array', items: linkSchema, description: 'The full new list of predecessors' },
  },
  additionalProperties: false,
} as const;

export const MOVE_SCHEMA = {
  type: 'object',
  properties: {
    task: { type: 'integer', description: 'Task code' },
    change: changeSchema,
    why: { type: 'string', description: `At most ${WHY_MAX} characters` },
  },
  required: ['task', 'change', 'why'],
  additionalProperties: false,
} as const;

/** The answer's shape, for providers that constrain output to a JSON schema. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    briefing: { type: 'string', description: `A PM's briefing, at most ${BRIEFING_MAX} characters` },
    risks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'The F line key, e.g. P4:12' },
          rank: { type: 'integer', minimum: 1 },
          why: { type: 'string' },
        },
        required: ['key', 'rank', 'why'],
        additionalProperties: false,
      },
    },
    moves: { type: 'array', items: MOVE_SCHEMA, maxItems: MOVES_MAX },
  },
  required: ['briefing', 'risks', 'moves'],
  additionalProperties: false,
} as const;

export const TOOLS = [
  {
    name: 'get_task',
    description: 'The full facts of one task: its row, note, links in and out, and every warning on it.',
    input_schema: {
      type: 'object',
      properties: { task: { type: 'integer', description: 'Task code' } },
      required: ['task'],
      additionalProperties: false,
    },
  },
  {
    name: 'simulate',
    description: 'What a set of moves would do, worked out by the scheduling engine: finish, P80, chance on time, double-bookings made or cleared. Use it to check an idea before proposing it.',
    input_schema: {
      type: 'object',
      properties: { moves: { type: 'array', items: { ...MOVE_SCHEMA, required: ['task', 'change'] }, maxItems: MOVES_MAX } },
      required: ['moves'],
      additionalProperties: false,
    },
  },
] as const;

/** Parse and check an answer, clipping text; an error names what is wrong, for one repair turn. */
export function checkAnswer(raw: unknown): { ok: true; answer: AdvisorAnswer } | { ok: false; error: string } {
  if (typeof raw === 'string') {
    const m = /\{[\s\S]*\}/.exec(raw);
    if (!m) return { ok: false, error: 'the answer is not JSON' };
    try { raw = JSON.parse(m[0]); } catch { return { ok: false, error: 'the answer is not valid JSON' }; }
  }
  const o = raw as Record<string, unknown>;
  if (!o || typeof o !== 'object') return { ok: false, error: 'the answer must be a JSON object' };
  if (typeof o.briefing !== 'string') return { ok: false, error: '"briefing" must be a string' };
  if (!Array.isArray(o.risks)) return { ok: false, error: '"risks" must be a list' };
  if (!Array.isArray(o.moves)) return { ok: false, error: '"moves" must be a list' };
  const risks = [];
  for (const r of o.risks as Record<string, unknown>[]) {
    if (typeof r?.key !== 'string' || typeof r?.why !== 'string') return { ok: false, error: 'each risk needs "key" and "why" strings' };
    risks.push({ key: r.key, rank: Number.isInteger(r.rank) ? (r.rank as number) : risks.length + 1, why: r.why.slice(0, WHY_MAX) });
  }
  const moves: AdvisorMove[] = [];
  for (const m of (o.moves as Record<string, unknown>[]).slice(0, MOVES_MAX)) {
    const checked = checkMove(m);
    if (typeof checked === 'string') return { ok: false, error: checked };
    moves.push({ ...checked, why: typeof m.why === 'string' ? m.why.slice(0, WHY_MAX) : '' });
  }
  return { ok: true, answer: { briefing: o.briefing.slice(0, BRIEFING_MAX), risks: risks.sort((a, b) => a.rank - b.rank), moves } };
}

export function checkMove(m: Record<string, unknown>): { task: number; change: AdvisorChange } | string {
  if (!Number.isInteger(m?.task)) return 'each move needs a whole-number "task" code';
  const c = m.change as Record<string, unknown>;
  if (!c || typeof c !== 'object') return 'each move needs a "change" object';
  const change: AdvisorChange = {};
  if (c.duration !== undefined) { if (!Number.isInteger(c.duration) || (c.duration as number) < 0) return '"duration" must be a whole number of working days'; change.duration = c.duration as number; }
  if (c.not_before !== undefined) { if (c.not_before !== null && !Number.isInteger(c.not_before)) return '"not_before" must be a working-day offset or null'; change.not_before = c.not_before as number | null; }
  if (c.environment !== undefined) { if (typeof c.environment !== 'string') return '"environment" must be a name'; change.environment = c.environment; }
  if (c.after !== undefined) {
    if (!Array.isArray(c.after)) return '"after" must be a list of links';
    const links: AdvisorLink[] = [];
    for (const l of c.after as Record<string, unknown>[]) {
      if (!Number.isInteger(l?.task)) return 'each link needs a "task" code';
      if (l.type !== undefined && !['FS', 'SS', 'FF'].includes(l.type as string)) return 'a link type is FS, SS or FF';
      if (l.lag !== undefined && !Number.isInteger(l.lag)) return 'a lag is a whole number of working days';
      links.push({ task: l.task as number, type: (l.type as AdvisorLink['type']) ?? 'FS', lag: (l.lag as number) ?? 0 });
    }
    change.after = links;
  }
  if (!Object.keys(change).length) return 'a move must change something';
  return { task: m.task as number, change };
}

type Search = NonNullable<ReturnType<typeof createSearch>>;

/** A move as ops, or why it cannot be one. */
export function opsOfMove(search: Search, ctx: SearchContext, m: Pick<AdvisorMove, 'task' | 'change'>): PlanOp[] | string {
  const byCode = new Map(search.root.facts.tasks.map((t) => [t.code, t]));
  const t = byCode.get(m.task);
  if (!t) return `there is no task ${m.task}`;
  const fields: OpFields = {};
  const c = m.change;
  if (c.duration !== undefined) fields.duration = c.duration;
  if (c.not_before !== undefined) fields.not_before = c.not_before === null ? null : dateAtOffset(ctx.statusDate, c.not_before, ctx.holidays);
  if (c.environment !== undefined) {
    const env = ctx.environments.find((e) => e.name.toLowerCase() === c.environment!.toLowerCase());
    if (!env) return `there is no environment called ${c.environment}`;
    fields.environment_id = env.id;
  }
  if (c.after) {
    const preds = [];
    for (const l of c.after) {
      const p = byCode.get(l.task);
      if (!p) return `there is no task ${l.task}`;
      preds.push({ id: p.id, lag: l.lag ?? 0, type: l.type ?? 'FS' });
    }
    fields.predecessors = preds;
  }
  return [{ op: 'update', id: t.id, fields }];
}

export type Verdict = { move: AdvisorMove; suggestion?: Suggestion; rejected?: string };

/** The engine's verdict on each move, alone: kept only if it lowers the risk and makes nothing worse. */
export function judgeMoves(
  ctx: SearchContext, start: Parameters<typeof createSearch>[1], version: string, moves: readonly AdvisorMove[],
  unmask: ReadonlyMap<string, string> = new Map(),
): Verdict[] {
  const search = createSearch(ctx, start);
  if (!search) return moves.map((move) => ({ move, rejected: 'the plan has a dependency loop' }));
  search.withForecast(search.root);
  const target = ctx.project.target_date;
  return moves.map((move) => {
    const ops = opsOfMove(search, ctx, move);
    if (typeof ops === 'string') return { move, rejected: ops };
    const e = search.tryOps(search.root.state, ops);
    if (!e) return { move, rejected: 'a save would refuse it, or it would make a loop' };
    if (e.newClashes > 0) return { move, rejected: 'it would make a new double-booking' };
    search.withForecast(e);
    const p80Before = search.root.forecast?.p80;
    const p80After = e.forecast?.p80;
    if (p80Before && p80After && (target ? lateBy(p80After, target, ctx.holidays) > lateBy(p80Before, target, ctx.holidays) : p80After > p80Before)) {
      return { move, rejected: 'it would make the P80 finish later' };
    }
    if (!search.improves(e, search.root, true)) return { move, rejected: 'it would not lower the risk of delay' };
    const t = search.root.facts.tasks.find((x) => x.code === move.task)!;
    const why = unmaskText(move.why, unmask);
    const title = describe(t, move.change, ctx.statusDate, ctx.holidays);
    return {
      move,
      suggestion: {
        id: seedOf(`${version}:advisor:${JSON.stringify(ops)}`).toString(36),
        profile: 'advisor',
        title,
        moves: [{ kind: 'MA', title, reason: why || 'Proposed by the advisor.', tradeoff: 'Proposed by the advisor; the numbers are the engine’s.', ops, task_ids: [t.id] }],
        ops,
        effect: effectOf(search, search.root, e, ctx),
        version,
      },
    };
  });
}

function describe(t: Parameters<typeof label>[0], c: AdvisorChange, status: ISODate, holidays?: ReadonlySet<ISODate>): string {
  const parts: string[] = [];
  if (c.duration !== undefined) parts.push(`make it ${c.duration} days`);
  if (c.not_before !== undefined) parts.push(c.not_before === null ? 'clear its start-no-earlier-than' : `start it no earlier than ${dateAtOffset(status, c.not_before, holidays)}`);
  if (c.environment !== undefined) parts.push(`move it to ${c.environment}`);
  if (c.after) parts.push(`set what it waits for to ${c.after.map((l) => `${l.task}${l.type && l.type !== 'FS' ? l.type : ''}${l.lag ? (l.lag > 0 ? `+${l.lag}` : l.lag) : ''}`).join(', ') || 'nothing'}`);
  return `${label(t)}: ${parts.join(', ')}`;
}

/** What POST /api/projects/:id/assistant/ask answers. */
export type AdvisorReply = {
  /** Who answered: the LLM (checked by the engine), or the engine alone when there is no LLM or it failed. */
  source: 'advisor' | 'engine';
  /** Why the engine answered alone, or a caveat on the advisor's answer. */
  note: string | null;
  briefing: string;
  risks: { key: string; rank: number; why: string }[];
  suggestions: Suggestion[];
  /** The advisor's moves the engine dropped, and why. */
  rejected: { title: string; reason: string }[];
  usage: {
    input: number; output: number; cacheRead?: number; cacheWrite?: number;
    prompt_tokens: number; digest_level: number; shown: number; total: number; turns: number; tools: string[];
  } | null;
  provider: string;
  cached: boolean;
};
