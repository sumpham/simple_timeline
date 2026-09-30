import { describe, expect, it } from 'vitest';
import { planProject } from '../shared/plan.ts';
import { planFacts, type PlanFacts } from '../shared/assistant/facts.ts';
import { assess } from '../shared/assistant/rules.ts';
import { buildDigest, dateAtOffset, offsetOf, unmaskText, type DigestInput } from '../shared/assistant/digest.ts';
import { estimateTokens, fitDigest } from '../shared/assistant/budget.ts';
import { checkAnswer, judgeMoves } from '../shared/assistant/validate.ts';
import type { PlanOp } from '../shared/assistant/moves.ts';
import type { PlanState, SearchContext } from '../shared/assistant/optimise.ts';
import { ask, RUBRIC } from '../server/llm/orchestrate.ts';
import { mockProvider } from '../server/llm/providers/mock.ts';
import { noneProvider } from '../server/llm/providers/none.ts';
import type { LlmProvider } from '../server/llm/provider.ts';
import type { Conflict, Task, TaskDependency } from '../shared/types.ts';

// 2026-03-02 is a Monday.
const MON = '2026-03-02';

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name: `Task ${id}`, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null, code: id + 100,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}
const dep = (predecessor_id: number, successor_id: number, lag = 0): TaskDependency => ({ predecessor_id, successor_id, lag, type: 'FS' });

function factsOf(tasks: Task[], deps: TaskDependency[], conflicts: Conflict[] = [], people: Record<number, number[]> = {}): PlanFacts {
  const o = planProject({ projectStart: MON, tasks, deps, bookings: [] });
  if ('cycle' in o) throw new Error();
  return planFacts({
    project: { id: 1, name: 'Card vault', priority: 'high', target_date: '2026-03-20' }, projectStart: MON, outcome: o,
    baseline: new Map(), people: new Map(Object.entries(people).map(([k, v]) => [Number(k), v])), conflicts,
    statusDate: MON, nearCriticalDays: 2, forecastRuns: 200,
  });
}

function input(f: PlanFacts, notes: Record<number, string> = {}): DigestInput {
  return {
    facts: f, findings: assess(f, { long_task_days: 20 }), notes: new Map(Object.entries(notes).map(([k, v]) => [Number(k), v])),
    people: new Map([[9, 'Mai Nguyen']]), environments: new Map([[7, 'SIT']]), branchOf: new Map(),
  };
}

const clash: Conflict = {
  environment_id: 7, env_name: 'SIT', env_kind: 'SIT', capacity: 1, start_date: '2026-03-03', end_date: '2026-03-04', peak: 2,
  booking_ids: [11, 12], projects: [{ id: 1, name: 'Card vault', priority: 'high' }, { id: 2, name: 'Loyalty relaunch', priority: 'high' }],
  overlap_days: 2, severity: 6,
};

describe('digest', () => {
  it('writes dates as working-day offsets that round-trip', () => {
    for (const d of ['2026-03-02', '2026-03-06', '2026-03-09', '2026-02-27', '2026-04-15']) {
      expect(dateAtOffset(MON, offsetOf(MON, d))).toBe(d);
    }
    expect(offsetOf(MON, MON)).toBe(0);
    expect(offsetOf(MON, '2026-03-09')).toBe(5);
    expect(offsetOf(MON, '2026-02-27')).toBe(-1);
  });

  it('keeps people, other projects and notes private unless allowed', () => {
    const f = factsOf([task(1, 5, { environment_id: 7, note: 'Vendor sign-off' }), task(2, 3)], [dep(1, 2)], [clash], { 1: [9] });
    const strict = buildDigest(input(f, { 1: 'Vendor sign-off' }), { level: 0, sendPeople: false, sendOtherProjects: false, sendNotes: false });
    const text = strict.network + strict.state;
    expect(text).not.toContain('Mai');
    expect(text).not.toContain('Loyalty');
    expect(text).not.toContain('Vendor');
    expect(text).toContain('R1');
    expect(text).toContain('O1(high)');
    expect(unmaskText('Ask R1 about O1', strict.unmask)).toBe('Ask Mai Nguyen about Loyalty relaunch');
    const open = buildDigest(input(f, { 1: 'Vendor sign-off' }), { level: 0, sendPeople: true, sendOtherProjects: true, sendNotes: true });
    expect(open.state).toContain('Mai Nguyen');
    expect(open.state).toContain('"Loyalty relaunch"');
    expect(open.state).toContain('Vendor sign-off');
  });

  it('names tasks by code, prunes what cannot hurt, and counts what it left out', () => {
    // Task 3 has float and no warning: it is summarised, not listed.
    const f = factsOf([task(1, 10), task(2, 5), task(3, 2)], [dep(1, 2), dep(3, 2)]);
    const d = buildDigest(input(f), { level: 1, sendPeople: false, sendOtherProjects: false, sendNotes: false });
    expect(d.network).toContain('101|Task 1|10|~||');
    expect(d.network).toContain('102|Task 2|5|~||101');
    expect(d.network).not.toContain('Task 3');
    expect(d.network).not.toMatch(/^103\|/m);
    expect(d.network).toContain('1 tasks not shown');
    expect(d.state).toContain('CP 101>102');
  });

  it('tightens level by level until it fits the budget', () => {
    const tasks = Array.from({ length: 120 }, (_, i) => task(i + 1, 1 + (i % 7), { name: `A long descriptive task name number ${i + 1}` }));
    const deps = tasks.slice(1).map((t, i) => dep(tasks[i % 40].id, t.id));
    const f = factsOf(tasks, deps);
    const roomy = fitDigest(input(f), { sendPeople: false, sendOtherProjects: false, sendNotes: false }, 100000);
    expect(roomy.level).toBe(0);
    const tight = fitDigest(input(f), { sendPeople: false, sendOtherProjects: false, sendNotes: false }, estimateTokens(roomy.network + roomy.state) / 3);
    expect(tight.level).toBeGreaterThan(0);
    expect(tight.tokens).toBeLessThan(roomy.tokens);
  });
});

describe('answers', () => {
  it('accepts a well-formed answer, clips it, and explains a bad one', () => {
    const good = checkAnswer(JSON.stringify({ briefing: 'x'.repeat(2000), risks: [{ key: 'P1:2', rank: 1, why: 'late' }], moves: [{ task: 101, change: { not_before: null }, why: 'y' }] }));
    expect(good.ok).toBe(true);
    if (good.ok) expect(good.answer.briefing.length).toBe(900);
    expect(checkAnswer('no json here')).toEqual({ ok: false, error: 'the answer is not JSON' });
    expect(checkAnswer({ briefing: 'b', risks: [], moves: [{ task: 'x', change: {} }] })).toMatchObject({ ok: false });
    expect(checkAnswer({ briefing: 'b', risks: [], moves: [{ task: 1, change: {} }] })).toMatchObject({ ok: false, error: 'a move must change something' });
  });

  it('keeps a move the engine confirms and drops one that makes a clash or a later P80', () => {
    const tasks = [task(1, 2), task(2, 5, { not_before: '2026-03-16' }), task(3, 3, { environment_id: 7 })];
    const deps = [dep(1, 2)];
    const apply = (s: PlanState, op: PlanOp): PlanState => {
      if (op.op !== 'update') throw new Error('update only');
      return { tasks: s.tasks.map((t) => (t.id === op.id ? { ...t, ...op.fields } as Task : t)), deps: s.deps };
    };
    const other = { id: 50, project_id: 2, environment_id: 7, kind: 'SIT', start_date: '2026-03-16', end_date: '2026-03-20', confidence: 'committed', optional: 0, project_name: 'Other', env_name: 'SIT', capacity: 1 };
    const ctx: SearchContext = {
      project: { id: 1, name: 'P', priority: 'normal', target_date: '2026-03-20' }, projectStart: MON, statusDate: MON, bookings: [],
      impact: { project: { id: 1, name: 'P', priority: 'normal' }, teamBookings: [other as never], environments: [{ id: 7, team_id: 1, name: 'SIT', kind: 'SIT', capacity: 1, sort_order: 0 }], resolved: new Set() },
      environments: [{ id: 7, team_id: 1, name: 'SIT', kind: 'SIT', capacity: 1, sort_order: 0 }],
      people: new Map(), baseline: new Map(), nearCriticalDays: 2, longTaskDays: 20, forecastRuns: 150, apply,
    };
    const verdicts = judgeMoves(ctx, { tasks, deps }, 'v', [
      { task: 102, change: { not_before: null }, why: 'the date holds it' },
      { task: 103, change: { not_before: 10 }, why: 'move it into the other booking' },
      { task: 101, change: { duration: 30 }, why: 'longer' },
      { task: 999, change: { duration: 1 }, why: 'no such task' },
    ]);
    expect(verdicts[0].suggestion?.profile).toBe('advisor');
    expect(verdicts[0].suggestion?.moves[0].kind).toBe('MA');
    expect(verdicts[1].rejected).toBe('it would make a new double-booking');
    expect(verdicts[2].rejected).toMatch(/P80|risk/);
    expect(verdicts[3].rejected).toBe('there is no task 999');
  });
});

describe('orchestrator', () => {
  const tools = { get_task: () => 'Task facts', simulate: () => 'finish +5 -> +3' };
  const network = 'PROJ "P"\nT code|name\n101|A';
  const state = 'STATUS date=2026-03-02\nF H4:1:2026-03-16 L2 I3 101 "Held by a date"';

  it('runs the mock through its tools to a checked answer, and reports cached tokens on the second call', async () => {
    const provider = mockProvider();
    const first = await ask({ provider, tier: 'fast', model: null, network, state, question: null, tools });
    expect(first.answer?.moves).toEqual([{ task: 101, change: { not_before: null }, why: expect.any(String) }]);
    expect(first.tools).toEqual(['get_task', 'simulate']);
    expect(first.turns).toBe(2);
    const second = await ask({ provider, tier: 'fast', model: null, network, state, question: 'again', tools });
    expect(second.usage.cacheRead).toBeGreaterThan(0);
  });

  it('puts the rubric and the network first, as cacheable, and the state last', async () => {
    let seen: Parameters<LlmProvider['complete']>[0] | null = null;
    const spy: LlmProvider = {
      id: 'spy', caps: { tools: false, jsonSchema: true, promptCache: true, countTokens: false },
      async complete(req) { seen = req; return { json: { briefing: 'b', risks: [], moves: [] }, usage: { input: 1, output: 1 } }; },
    };
    await ask({ provider: spy, tier: 'strong', model: 'm', network, state, question: 'Why late?', tools });
    expect(seen!.system.map((s) => s.cache)).toEqual(['stable', 'stable']);
    expect(seen!.system[0].text).toBe(RUBRIC);
    expect(seen!.system[1].text).toContain(network);
    expect(seen!.messages[0]).toMatchObject({ role: 'user', content: [{ cache: 'volatile' }] });
    expect(seen!.tools).toBeUndefined();
  });

  it('repairs a malformed answer once, then gives up', async () => {
    let calls = 0;
    const flaky: LlmProvider = {
      id: 'flaky', caps: { tools: false, jsonSchema: false, promptCache: false, countTokens: false },
      async complete() { calls++; return { text: calls === 1 ? 'Sure! Here you go' : '{"briefing":"ok","risks":[],"moves":[]}', usage: { input: 1, output: 1 } }; },
    };
    expect((await ask({ provider: flaky, tier: 'fast', model: null, network, state, question: null, tools })).answer?.briefing).toBe('ok');
    const broken: LlmProvider = { ...flaky, async complete() { return { text: 'never JSON', usage: { input: 1, output: 1 } }; } };
    expect((await ask({ provider: broken, tier: 'fast', model: null, network, state, question: null, tools })).error).toMatch(/schema/);
  });

  it('falls back on no provider and on a timeout, without throwing', async () => {
    const none = await ask({ provider: noneProvider, tier: 'fast', model: null, network, state, question: null, tools });
    expect(none.unavailable).toBe(true);
    const slow: LlmProvider = {
      id: 'slow', caps: { tools: false, jsonSchema: true, promptCache: false, countTokens: false },
      complete: (_req, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
    };
    const late = await ask({ provider: slow, tier: 'fast', model: null, network, state, question: null, tools, timeoutMs: 20 });
    expect(late.error).toBe('The advisor took too long');
  });
});
