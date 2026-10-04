import { ANSWER_SCHEMA, checkAnswer, TOOLS, type AdvisorAnswer } from '../../shared/assistant/validate.ts';
import { LlmUnavailable, type LlmMessage, type LlmProvider, type LlmUsage, type Segment } from './provider.ts';

/**
 * One question to the advisor: build the prompt (stable rubric first, then the
 * plan's network, then its state and the question), run the tool loop with the
 * engine answering every tool call, and check the answer against its schema,
 * with one repair turn. Anything that goes wrong returns an error for the caller
 * to fall back on; it never throws past here.
 */

export const MAX_TOOL_TURNS = 4;
export const TIMEOUT_MS = 45_000;

/**
 * What the advisor is, what it reads and what it may say. Long and unchanging on
 * purpose: it is the part a provider caches, so every later ask pays little for it.
 */
export const RUBRIC = `You advise a project manager on one project's plan. The plan is scheduled by an engine (critical path method, working days, Monte Carlo forecast). You read the engine's facts; you never compute dates or float yourself, and you never state a number the facts do not give.

Practice you apply:
- PMBOK schedule and risk management: rank risks by likelihood x impact; act first on what threatens the finish and the promise (target).
- Critical path: tasks with total float <= 0 set the finish; near-critical tasks (small float) become critical after a small slip.
- Earned schedule: pace (SPI(t)) below 0.9 on work in progress means it will finish late at its current rate.
- Merge bias: a critical task waiting on several paths starts late more often than the plan shows.
- DCMA 14-point checks: missing links, leads, long lags, hard date constraints, long tasks and very high float make the dates less trustworthy.
- Schedule risk analysis: P50 and P80 are the finishes half and four in five simulated runs meet; the criticality index says how often a task set the finish.
- Compression: fast-tracking (overlap, rework risk) and crashing (more people, cost and ramp-up) shorten the critical path; levelling within float and moving to a free environment remove double-bookings without moving the finish.
- Critical Chain: protect the promise with one project buffer rather than padding every task.
- A double-booking (two projects in one environment beyond its capacity) is the board's main alarm. Never propose a move that would create one.

How the facts are written (the plan's own shorthand, to save space):
- Offsets: every date is a number of working days from the status date: 0 is the status date, +5 five working days later, -3 three before. Weekends and holidays are already skipped.
- PROJ: the project and its priority.
- T code|name|dur|best-worst|env|after: a task's code, name, planned working days, best and worst case (~ means the forecast's default range), the environment it books, and what it waits for (codes; SS start-to-start, FF finish-to-finish, +n lag, -n lead).
- ~ lines: tasks left out because they cannot hurt the finish now.
- STATUS: status date, finish, target, days late, P50, P80, chance on time.
- CP: the critical path, in order.
- S code|st|prog|start|end|tf|pace|who|flags: status (t to do, p in progress, b blocked, d done), typed % complete, start and end offsets, total float, pace (SPI(t)), people, flags (C critical, N near-critical, M merge point, then warning rules).
- X: a double-booking this project is in: environment, span, capacity, peak, the other projects, and this project's tasks there.
- CI: criticality index. SENS: correlation of a task's length with the finish.
- F key L I tasks "title": a warning. Rules: P1 target at risk, P2 negative float, P3 should have started, P4 falling behind, P5 blocked on the critical path, P6 margin shrinking, P7 behind baseline, P8 deadline at risk, S1 close to critical, S2 many paths meet, S3 thin margin, S4 double-booked where tight, S5 one person on parallel critical work, S6 critical work unassigned, H1 missing links, H2 leads, H3 lags, H4 held by a date, H5 long tasks, H6 very high float, H7 person on two tasks at once.
- N code "note": a task's note, when sharing notes is allowed.
- Names like R1 (a person) or O2 (another project) are kept private. Use them as given.

Tools: get_task returns one task's full facts. simulate returns what the engine says a set of moves would do. Check a move with simulate before proposing it. You have at most ${MAX_TOOL_TURNS} tool turns.

Your answer is one JSON object, nothing else:
- briefing: what the PM should know and do first, in plain words, at most 900 characters. Say why, using the facts' numbers.
- risks: the warnings (by their F key) in the order the PM should act on them, each with why, in one or two sentences. Use judgement the rules cannot: what a task's name or note says (a vendor, a sign-off, an approval) about how likely it is to slip.
- moves: at most 5 plan changes that lower the risk of delay. Each names a task code and only the fields to change: duration, not_before (an offset, or null to clear), environment (a name from the facts), or after (the full new list of predecessors). Give why for each, including its trade-off. The engine checks every move and drops any that makes a double-booking or a later P80, so propose only moves you have simulated.

Schema:
${JSON.stringify(ANSWER_SCHEMA)}`;

export type AskResult = {
  answer?: AdvisorAnswer;
  error?: string;
  unavailable?: boolean;
  usage: LlmUsage;
  turns: number;
  tools: string[];
  model?: string;
};

export type ToolHandlers = {
  get_task: (args: unknown) => string;
  simulate: (args: unknown) => string;
};

export async function ask(o: {
  provider: LlmProvider;
  tier: 'fast' | 'strong';
  model: string | null;
  network: string;
  state: string;
  question: string | null;
  tools: ToolHandlers;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<AskResult> {
  const usage: LlmUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const used: string[] = [];
  const add = (u: LlmUsage) => {
    usage.input += u.input;
    usage.output += u.output;
    usage.cacheRead = (usage.cacheRead ?? 0) + (u.cacheRead ?? 0);
    usage.cacheWrite = (usage.cacheWrite ?? 0) + (u.cacheWrite ?? 0);
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? TIMEOUT_MS);

  const system: Segment[] = [
    { text: RUBRIC, cache: 'stable' },
    { text: `The plan's network:\n${o.network}`, cache: 'stable' },
  ];
  const messages: LlmMessage[] = [{
    role: 'user',
    content: [{
      text: `${o.state}\n\n${o.question ? `The PM asks: ${o.question.slice(0, 500)}` : 'Brief the PM on this plan, and propose moves that lower the risk of delay.'}`,
      cache: 'volatile',
    }],
  }];
  const tools = o.provider.caps.tools ? TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })) : undefined;
  let repaired = false;
  let turns = 0;
  let model: string | undefined;

  try {
    // Tool turns, then the answer; one extra turn for a repair. Bounded either way.
    for (let step = 0; step < MAX_TOOL_TURNS + 2; step++) {
      const allowTools = tools && turns < MAX_TOOL_TURNS ? tools : undefined;
      const res = await o.provider.complete({
        tier: o.tier, model: o.model, system, messages, tools: allowTools, output: ANSWER_SCHEMA, maxOutputTokens: o.maxOutputTokens ?? 1500,
      }, controller.signal);
      add(res.usage);
      model = res.model ?? model;
      if (res.toolCalls?.length && allowTools) {
        turns++;
        messages.push({ role: 'assistant', text: res.text, toolCalls: res.toolCalls, raw: res.raw });
        messages.push({
          role: 'tool',
          results: res.toolCalls.map((c) => {
            used.push(c.name);
            const handler = o.tools[c.name as keyof ToolHandlers];
            let content: string;
            try { content = handler ? handler(c.args) : `No tool called ${c.name}.`; } catch (err) { content = `The tool failed: ${(err as Error).message}`; }
            return { id: c.id, name: c.name, content };
          }),
        });
        continue;
      }
      const checked = checkAnswer(res.json ?? res.text ?? '');
      if (checked.ok) return { answer: checked.answer, usage, turns, tools: used, model };
      if (repaired) return { error: `The advisor's answer did not match the schema: ${checked.error}`, usage, turns, tools: used, model };
      repaired = true;
      messages.push({ role: 'assistant', text: res.text ?? JSON.stringify(res.json ?? ''), raw: res.raw });
      messages.push({ role: 'user', content: [{ text: `That did not match the schema: ${checked.error}. Reply with the JSON object only.`, cache: 'volatile' }] });
    }
    return { error: 'The advisor did not finish within its turns', usage, turns, tools: used, model };
  } catch (err) {
    const aborted = controller.signal.aborted;
    return {
      error: aborted ? 'The advisor took too long' : err instanceof Error ? err.message : 'The advisor failed',
      unavailable: err instanceof LlmUnavailable,
      usage, turns, tools: used, model,
    };
  } finally {
    clearTimeout(timer);
  }
}
