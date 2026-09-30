# Smart assistant for the project manager

Requirement, solution and impact assessment. Drafted 2026-09-30; **design only, nothing built.**
Two approaches are described: an internal engine (§5) and an external LLM with token
optimisation (§6). §7 compares them and recommends an order. §9 records the decisions, and §10
is the build plan as a to-do list. Builds on the plan
(`DESIGN.md` §16), sub-tasks (`reqs/sub_tasks.md`), the Gantt chart (`reqs/gantt_chart.md`)
and resources (`reqs/resources.md`).

## 1. What is asked

Using a project's current tasks, plan, network and progress, the assistant should:

1. **Warn** about risks to the project's progress, before they show up as a missed date.
2. **Suggest a better plan**, where "better" means **less risk of delay**, and show what the
   suggestion would change before anyone accepts it.

Two ways to build it are asked for: (A) an internal engine, and (B) an external LLM whose
input is made as small as possible before each request. Both must follow industry practice
in project management.

## 2. Where we start

Most of what an assistant needs is already computed. It only has to be read.

| Already there | Where | What the assistant uses it for |
|---|---|---|
| CPM forward/backward pass, total and free float, critical flag | `scheduleProject` (shared/schedule.ts) | Critical path, near-critical paths, float erosion |
| Plan outcome: dated tasks, holds, bookings | `planProject` (shared/plan.ts) | The "what if" simulator for every suggestion |
| Before/after impact with a risk level | `planImpact`, `riskOf` | Scoring a suggestion; same banner as a manual edit |
| Double-bookings with resolutions | `conflictsFor`, `openConflicts` | Environment risk; the product's core alarm |
| Target date and `lateBy` | `project.target_date`, schedule.ts | Finish variance against the promise |
| Baseline snapshot | `task_baseline` | Slippage, Baseline Execution Index |
| Status, actuals, progress % | `task.status`, `actual_*`, `progress` | Earned-schedule progress rate |
| "Should have started" mark | Plan.tsx (the overdue flag) | One rule today, computed in a component; moves to shared/ |
| People on tasks | `task_resource` | Single points of failure, later over-allocation |
| Change ops with preview | `applyChange` ops, `POST /api/tasks/preview` | How a suggestion is shown and applied |

What is missing:

- **No uncertainty.** A duration is one number, so there is no way to say "70% chance of
  meeting the target".
- **No schedule-quality checks.** Nothing flags missing logic, leads, hard constraints or
  over-long tasks.
- **No progress trend.** `progress` is stored but never compared with elapsed time.
- **No search.** `planImpact` scores one change that a person has made. Nothing proposes one.

## 3. The industry practice this is built on

Every rule below cites where it comes from, so a PM can see that a warning is standard
practice and not a quirk of the tool.

| Practice | Source | Used for |
|---|---|---|
| Critical Path Method, total/free float | PMBOK 7 (Planning & Measurement performance domains); PMI Practice Standard for Scheduling | Critical and near-critical work (already built) |
| **DCMA 14-Point Schedule Assessment** | US Defense Contract Management Agency; widely used as a schedule health check | Schedule-quality warnings (§4.1 H-rules) |
| **Earned Schedule**, SPI(t) | Lipke; PMI Practice Standard for EVM | Is work keeping pace? (§4.1 P-rules) Uses time, not cost, which fits a plan with no cost data |
| **Schedule Risk Analysis** (Monte Carlo) | AACE RP 57R-09; PMI Practice Standard for Project Risk Management | P50/P80 finish, chance of meeting target, criticality index |
| **Merge bias** | Standard SRA finding: tasks with several predecessors start late more often than CPM shows | Warns about merge points on the critical path |
| Probability × impact matrix | PMBOK risk management; ISO 31000 | Ranking warnings on one scale |
| **Schedule compression**: fast-tracking and crashing | PMBOK schedule management | The two main "better plan" moves |
| Resource levelling and smoothing | PMBOK | Moving non-critical work within its float to clear clashes |
| **Critical Chain** project buffer | Goldratt; aggregated contingency | Suggests a buffer before the target, sized from the P80−P50 spread |
| 8/80 rule, decomposition | WBS practice (PMI Practice Standard for WBS) | Suggests splitting over-long tasks |

## 4. What the assistant produces

Both approaches produce the same three outputs, so the UI and tests do not depend on which
one answered.

### 4.1 Warnings (the risk register)

Each warning is a **finding**: a rule id, the tasks, bookings or people it concerns, a
**likelihood** (1–5), an **impact** (1–5), a plain sentence, and the evidence (numbers from the
engine, never estimates). Severity is likelihood × impact, as in a standard P×I matrix. Impact
is measured in **working days of finish delay** against remaining float and target slack,
scaled up by project priority (`PRIORITY_RANK`).

**Progress (P): is it slipping now?**

| ID | Rule | Default threshold |
|---|---|---|
| P1 | **Target at risk**: forecast finish (P80, §5.3) is after `target_date` | Any late day. Deterministic lateness shows as well |
| P2 | **Negative float**: the plan already cannot meet a constraint | TF < 0 |
| P3 | **Should have started**: todo/blocked, scheduled start before today | Today's overdue mark, moved into shared/ |
| P4 | **Slipping in progress**: progress rate projects the finish after the scheduled end. Earned-schedule SPI(t) = progress% × duration ÷ working days elapsed. Only a **typed** progress counts (an untyped figure is itself estimated from elapsed time), and only after 2 working days | SPI(t) < 0.9, or projected slip > free float |
| P5 | **Blocked on the critical path**: a blocked task has float at or below the near-critical threshold | TF ≤ near-critical |
| P6 | **Float erosion**: project float against the baseline has shrunk | Critical float down by > 50% since baseline |
| P7 | **Baseline slippage**: finish later than baseline; DCMA BEI (tasks finished ÷ tasks due to finish by today) | BEI < 0.95 |

**Structure (S): will the plan hold up?**

| ID | Rule | Default threshold |
|---|---|---|
| S1 | **Near-critical path**: a second chain with little float, so a small slip makes it critical | TF ≤ 2 wd, or ≤ 10% of remaining duration |
| S2 | **Merge point on the critical path**: a critical task with several predecessors (merge bias) | ≥ 3 predecessors |
| S3 | **Thin margin to target**, by the Critical Path Length Index (DCMA #13): (remaining CP length + margin to target) ÷ remaining CP length. Below 1 the plan is late, which P1 already says, so S3 warns before that | CPLI < 1.05 while still on time |
| S4 | **Environment clash on the plan's path**: an open double-booking overlaps a hold whose tasks are critical or near-critical | Any. `--alarm` stays the booking's own mark |
| S5 | **One person, parallel critical work**: one person on critical tasks that run at the same time. (A critical task with a single person was dropped as a rule: most tasks have one person, so it was noise) | ≥ 2 overlapping critical tasks |
| S6 | **Unassigned critical work**, in plans that name people at all | Critical leaf task with no person |

**Schedule hygiene (H): the DCMA checks that apply here.** These are lower severity. They
warn that the dates the CPM gives cannot be trusted.

| ID | DCMA | Rule |
|---|---|---|
| H1 | #1 Logic | A leaf task with no predecessor or no successor, other than the project's first and last. Its float is meaningless |
| H2 | #2 Leads | Negative lag |
| H3 | #3 Lags | Lag on more than 5% of links, or any lag longer than the successor |
| H4 | #5 Hard constraints | `not_before` that currently drives a task's start (it would start earlier without it) |
| H5 | #8 High duration | Duration > 20 wd: the 8/80 rule, decided in §9. It is stricter than DCMA's 44 wd and is a setting |
| H6 | #6 High float | TF > 44 wd, which usually means a missing link |

A PM can **dismiss** a finding. That works like accepting a double-booking: a key made from
the rule id and the exact entities it concerns (the same idea as `conflictKey`). A dismissed
finding is still listed, greyed out, and comes back if the facts change, for example when a
new task joins the merge.

### 4.2 Forecast

- Deterministic finish (today's CPM) and **P50 / P80 finish** from schedule risk analysis.
- **Chance of meeting the target**, as a percentage.
- **Criticality index** per task: how often the task was on the critical path across the
  runs. This finds tasks that are *not* critical today but often become critical, which CPM
  alone cannot show.
- **Sensitivity**: which task durations move the finish most. This is the tornado chart that
  risk-analysis tools draw.

### 4.3 Suggestions (the better plan)

A suggestion is **a list of the existing change ops** (`create`, `update`, `delete`,
`outline`, link edits) plus the reason for it. That choice matters most in the whole design:

- It previews through `POST /api/tasks/preview`, so the PM sees the **same impact banner** as
  for a manual edit: moved tasks, finish, bookings, and double-bookings made or cleared.
- It applies through the same routes, so `replan` runs, auto bookings keep their ids, and
  Undo works. **The assistant never writes to the database itself.**
- Suggestions carry the plan version they were computed on. If the plan has changed since,
  Apply recomputes the preview first and does not save blind.

| ID | Move | Practice | What the engine can do by itself |
|---|---|---|---|
| M1 | **Level within float**: move a non-critical task (`not_before`) inside its free float to clear an environment clash | Resource levelling | Yes. Finish does not move, so this is the safest move |
| M2 | **Switch environment**: move a hold to another environment of the same kind with spare capacity | Levelling across resources | Yes, checked with `conflictsFor` |
| M3 | **Fast-track**: turn a critical FS link into SS + lag, or add a lead, overlapping at most 50% of the predecessor | PMBOK fast-tracking | Proposes it. Flagged "adds rework risk" and never ranked above M1/M2 |
| M4 | **Remove a driving constraint**: a `not_before` that is holding a critical task | DCMA #5 | Proposes it, with the constraint's note as the reason to check |
| M5 | **Drop a redundant link**: A→C when A→B→C already implies it, where it inflates merge bias | Logic cleanup | Yes, found by transitive reduction |
| M6 | **Crash**: shorten a critical task's duration by adding people | PMBOK crashing | Proposes "−N days needs about +M person-days". There is no cost data, so the PM decides |
| M7 | **Split a long task** so its successor can start on the first part | Decomposition, 8/80 | Proposes a split. The PM names the parts |
| M8 | **Buffer**: a milestone before the target, sized at P80 − P50 | Critical Chain project buffer | Yes. Protects the promise without padding every task |
| M9 | **Unblock / escalate**: a blocked critical task | Issue management | An action item, not a plan change |

Each suggestion states its **trade-off** (for example, fast-tracking means overlapping work
that may need redoing). None is applied automatically.

## 5. Approach A: the internal engine

### 5.1 Shape

```
                      ┌──────────────────────── shared/assistant/ (pure, tested) ─────────────────────┐
 tasks, deps,         │                                                                                │
 bookings, baseline ──► facts.ts ──► rules.ts ──► findings[] ─────────────────┐                        │
 progress, people     │   (derive)    (P/S/H)                                  │                        │
 holidays, today      │      │                                                 ▼                        │
                      │      ├──► forecast.ts (Monte Carlo SRA) ──► P50/P80, criticality, sensitivity   │
                      │      │                                                 │                        │
                      │      └──► moves.ts (M1–M9 candidates) ──► optimise.ts ─┴─► suggestions[]        │
                      │                                              │   ▲                              │
                      │                     planProject + planImpact │   │ score                        │
                      │                     + conflictsFor ──────────┘───┘ (the same functions as a save)│
                      └────────────────────────────────────────────────────────────────────────────────┘
                                   │
     server: GET /api/projects/:id/assistant ──► client: Assistant panel ──► Preview ──► Apply (existing routes)
```

Everything is in `shared/`, like scheduling and holds, and for the same reason: the numbers a
suggestion promises must be the numbers the save produces. Rules and moves **call**
`planProject`, `planImpact` and `conflictsFor`. They never reimplement overlap, float or span
maths.

### 5.2 Facts (`facts.ts`)

This is one pass over a `PlanOutcome` plus the extras below. It produces a flat, typed
**PlanFacts**: per task its code, status, remaining duration, ES/EF, TF/FF, critical flag,
predecessor count, SPI(t), baseline variance, people, environment and hold; per project its
finish, target slack, CPLI, BEI and open conflicts on its holds. Rules read facts and never
raw rows. **Approach B sends the same facts too** (§6.2), so the two approaches share one
source of truth.

"Today" is the **status date**, passed in and never read from the clock inside `shared/`, so
tests are deterministic.

### 5.3 Forecast: Monte Carlo schedule risk analysis (`forecast.ts`)

- **Duration ranges.** A task has a range for its remaining duration:
  - With a three-point estimate (**Best** and **Worst** columns, decided in §9; §8.1), use
    those, scaled to the remaining share of the task.
  - Where a task has no estimate, a default by state: todo −10%/+30% (the right skew real
    projects show); in progress, the range comes from its SPI(t), so a task running at 0.7
    gets a pessimistic tail; done, fixed.
  - The panel says how many critical tasks are running on defaults, since that is the
    forecast's weakest input.
- **Distribution.** Triangular, or PERT-beta. Each run samples every remaining leaf duration
  and runs the **same forward pass** on working-day indexes.
- **Cost bound.** 1,000 runs, a seeded PRNG (the same plan gives the same answer), and a
  forward pass only. Holds and bookings are not needed for dates. The loop count is fixed,
  as for the ruler's loops (CLAUDE.md "bounded loops").
  - 200 tasks × 1,000 runs is about 200k task relaxations, a few ms to tens of ms.
  - Run on demand and cache by plan hash, not on every keystroke.
- **Correlation.** Leave it out for now; the doc says so. Ignoring correlation makes a
  forecast optimistic, and that is standard SRA guidance. A later option is one global
  "estimating bias" factor, sampled once per run.

`scheduleProject` would need a small refactor. The forward pass becomes an exported function
that takes durations as an array, so the Monte Carlo runs do not rebuild maps each time. The
public API and behaviour stay as they are, and the existing tests pin them.

### 5.4 Optimiser (`optimise.ts`)

The objective is **lexicographic**, in this order, so a move can never trade the product's core
promise for a better number:

1. Make **no new open double-booking** (a hard rule, as in `riskOf`).
2. Minimise **P80 days late** against the target (or the deterministic finish when there is no target).
3. Minimise the **deterministic finish**.
4. Maximise the **smallest float on near-critical chains** (robustness).
5. Minimise **disruption**: number of ops, tasks moved, weighted by move type
   (M1 < M5 < M4 < M2 < M8 < M3 < M7 < M6).

The search is a **bounded beam search**:

- Beam width 3, depth ≤ 3 moves, ≤ 40 candidates per step, and a hard cap of 500
  `planProject` calls per request.
- A candidate is scored with the deterministic plan first. Only the top few get a quick
  Monte Carlo (200 runs) to rank on P80.
- The result is **up to 3 alternative plans**, for example "Safe: level only", "Balanced" and
  "Aggressive: fast-track". Each is a list of moves with its combined impact.
- The PM can accept a single move from a plan. Each move is valid on its own because it is
  re-previewed.

This is deliberately not an exact optimiser (CP-SAT, MILP):

- It has no dependencies, and the result is explainable one move at a time.
- A PM will only accept a handful of changes, so a depth-3 search over good heuristics covers
  what matters.

### 5.5 Explanations

Every finding and move comes with a **template sentence filled with engine numbers**, for
example:

> "Build API (T12) is 40% done after 6 of 10 working days. At this rate it finishes 3 working
> days late, and it has 0 days of float, so the release moves to 14 Oct, 2 days past target."

No free text is generated, so nothing can be wrong that the numbers do not already say.

### 5.6 Properties

- **Strengths:** offline, which matters because the packed build runs with no internet
  (CLAUDE.md "Packing"). It is deterministic, testable, free per use, instant, and its numbers
  are always right.
- **Limits:**
  - It cannot read meaning from task names and notes. It will not know that "Vendor sign-off"
    is outside the team's control, or that two tasks are the same kind of work.
  - Its suggestions come only from the catalogue M1–M9.
  - Its wording is templated.

## 6. Approach B: external LLM with token optimisation

### 6.1 Principle: the LLM advises, the engine decides

An LLM is good at reading names and notes, weighing trade-offs, ranking by context and writing
a clear briefing. It is bad at date arithmetic on working-day calendars and at checking graph
constraints. So:

- The **engine computes every number** (§5.2–5.3) and **checks every suggestion** (§5.4
  scoring, via `planProject` + `planImpact`).
- The LLM receives **pre-digested facts**, not raw rows. It returns **structured JSON**:
  ranked risks with its reasoning, and proposed moves as change ops written in **task codes**.
- A proposed move that fails validation is dropped, and the drop is recorded:
  - a code that does not exist, a loop, a field set on a summary (`refuseSummaryFields`);
  - or a move that makes a new double-booking or a later P80.
- The UI **shows engine numbers, never LLM numbers.** The LLM's text says *why*; the preview
  banner says *what*.

In effect B is **A plus a reasoning layer**. It needs `facts.ts`, `rules.ts` and the
simulator from A anyway. That is the main input to the recommendation in §7.

```
PlanFacts ──► digest.ts ──► budget.ts ──► prompt (cached prefix + volatile tail) ──► LLM
 (from A)     prune+encode   fit tokens                                              │
                                                                   tool calls ◄──────┤ get_task / simulate
                                                           (answered locally,        │
                                                            by the engine)           ▼
                                                          JSON: risks[], moves[] (task codes)
                                                                                     │
                                          validate.ts: codes exist, ops legal, planImpact ok
                                                                                     │
                                                    Assistant panel (engine numbers + LLM reasons)
```

### 6.2 Token optimisation, in order of how much each saves

**1. Send facts, not the plan.** A 150-task plan with deps, bookings and people is roughly
40–60k tokens as the API's JSON. The digest is 2–4k.

**2. Prune the network to what can hurt.** Keep:

- the critical path and near-critical tasks (TF ≤ threshold);
- tasks with a finding;
- the direct predecessors of those tasks;
- holds that touch an open conflict.

Collapse the rest into one line per summary branch, for example:

```
~ WBS 3 "Data migration": 14 tasks, 11 done, min TF 18wd, no findings
```

Done tasks are counted, not listed. On a typical plan this keeps 15–30% of tasks.

**3. Compact encoding.**

- Rows are pipe-separated, with a header line, instead of JSON (JSON repeats every key on
  every row).
- Tasks use **task codes**, not database ids.
- Dates are **working-day offsets from the status date** (`+12`, `-3`). The LLM never has to
  do calendar maths, and short integers cost fewer tokens than `2026-10-14`. `digest.ts`
  converts back.
- Enums are one letter (status `t/p/b/d`; flags `C` critical, `N` near-critical, `M` merge,
  `X` clash).
- Null columns are omitted. Names are cut to 40 characters.
- Notes are sent **only for tasks with a finding**, cut to 160 characters.

```
PROJ Payments R3 | status=2026-09-30 | target=+24 | finish=+27 | p50=+28 | p80=+33 | onTime=22%
CP 4>7>12>14>21
T code|name|st|rem|es|ef|tf|pred|env|who|spi|flags
7|Build API|p|6|-6|+6|0|4|SIT|R1|0.7|C,M
12|SIT regression|t|8|+6|+14|0|7|SIT|R1,R2||C,X
X SIT +8..+12 cap1 peak2 with "Loyalty app"(high)
F P4 7 L4 I4 "SPI(t)=0.70, projected +3wd"
F S5 R1 on 7,12 overlapping +0..+6
```

**4. Pull detail on demand, don't push it.** Give the model two tools, both answered locally
and cheaply:

- `get_task(code)` returns the full row, the note, and its links.
- `simulate(ops)` returns the engine's impact summary: finish Δ, P80 Δ, conflicts made or
  cleared.

The first message carries only the digest. The model asks for what it needs. Tool turns are
capped at 4. `simulate` also lets the model check its own ideas before proposing them.

**5. Prompt caching.** Order the prompt from most stable to least stable, and mark the stable
segments as cacheable. The prompt is built as **segments tagged `stable` or `volatile`**. Each
provider adapter maps those tags onto its own caching (explicit cache breakpoints for some
providers, automatic prefix caching for others), so the ordering wins everywhere:

1. System role and PM rubric (§3 practices, rule glossary, output schema, tool definitions).
   This is the same for every call and every project.
2. The project's **structure** (the network digest). This changes only when tasks or links
   change.
3. The **volatile tail**: status date, progress, findings, the user's question.

Repeat questions in a session pay mostly cache-read rates. Confirm the model's minimum
cacheable prefix size at build time. The rubric should be written long enough to reach it.

**6. Delta follow-ups.** In a conversation ("what if we delay T14 instead?"), send only the
facts that changed since the last digest (hash per row), not a new digest.

**7. Skip the call when nothing changed.** Cache the answer by `hash(digest + question)`. The
panel shows the cached briefing until the plan hash changes.

**8. Budget and degrade.**

- `budget.ts` estimates tokens (count locally at about 4 characters per token, and optionally
  confirm with the provider's token-count endpoint).
- If the digest is over budget (default 6k input tokens), it tightens step by step until it
  fits:
  1. Lower the near-critical threshold.
  2. Drop the H-rule findings.
  3. Drop notes.
  4. Send the critical path only.

**9. Small outputs.** Use a strict JSON schema for the answer, cap the length of each reason,
and set `max_tokens` to fit. The narrative briefing is a separate, optional short field.

**10. Route by task.** There are two model **tiers**, not model names:

- `fast` writes the risk briefing and ranks the findings. It is cheap and runs often.
- `strong` handles re-plan requests, which are rare and call tools.

Each tier maps to a provider and a model in settings. The code never names a model.

**Privacy (part of the digest, not an afterthought):**

- People are sent as `R1, R2…` and mapped back locally.
- Project names of *other* projects in a clash are optional (off by default: "another high-priority project").
- Notes can be turned off entirely.
- The API key lives only in the server's environment. The browser never calls the LLM.

### 6.3 Server shape: a seam, provider still to choose

No provider has been chosen (§9). The design therefore builds **everything provider-neutral
now** and leaves one small file per provider for later. Adding a cloud LLM should be: write
one adapter, set the environment variables, and turn it on in settings.

```ts
// server/llm/provider.ts — the only thing an adapter implements.
export interface LlmProvider {
  readonly id: string;                              // 'none', 'mock', later 'anthropic', 'openai', 'azure', 'local', …
  readonly caps: { tools: boolean; jsonSchema: boolean; promptCache: boolean; countTokens: boolean };
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
  countTokens?(req: LlmRequest): Promise<number>;   // optional; budget.ts estimates otherwise
}

export type LlmRequest = {
  tier: 'fast' | 'strong';                          // resolved to a model by settings, never in code
  segments: { role: 'system' | 'user'; text: string; cache: 'stable' | 'volatile' }[];
  tools?: ToolSpec[];                               // get_task, simulate — JSON-schema'd
  output: JsonSchema;                               // the answer's shape (§4)
  maxOutputTokens: number;
};
export type LlmResponse = {
  json?: unknown; toolCalls?: { name: string; args: unknown }[]; text?: string;
  usage: { input: number; output: number; cacheRead?: number; cacheWrite?: number };
};
```

What sits in front of the seam is provider-neutral and built now:

- `shared/assistant/digest.ts`, `budget.ts` and `validate.ts` (pure).
- `server/llm/orchestrate.ts` runs the loop:
  - it builds segments, checks the budget, and calls the provider;
  - it answers tool calls through the engine, capped at 4 turns;
  - it validates the answer and falls back to engine A when anything fails.
- **Capability fallbacks:**
  - A provider without native tools gets the digest with detail inlined, trimmed to budget.
  - A provider without JSON-schema output has its text parsed and checked against the schema,
    with one repair retry.
  - Without caching, the call works the same and costs more.
- **Built-in providers:**
  - `none` is the default. It always falls back to engine A, and the UI hides "Ask".
  - `mock` returns fixed answers, so the orchestrator, validator and UI are tested with no
    network and no key.
- **Settings:**
  - Provider id, the model for each tier, the token budget and the privacy switches.
  - Endpoint URL and API key come **from the environment only**: `ASSISTANT_LLM_URL`,
    `ASSISTANT_LLM_KEY`.
  - A company gateway or a self-hosted model is just a different URL.
- **Usage log.** Every call's `usage` is written to a small `assistant_llm_log` table (tokens
  in/out/cached, latency, provider, fallback reason). The token optimisation can then be
  measured, not assumed.

Later, one adapter per provider: `server/llm/providers/<name>.ts`, about 100 lines. It maps
segments, tools and schema onto that provider's API, using `fetch`, which is built into
Node 24, so there is no SDK dependency to pack.

- `POST /api/projects/:id/assistant/ask { question?, mode: 'brief' | 'replan' }`.
  - It returns the same `{ findings, forecast, suggestions }` shape as A, plus `reasons` and
    `briefing`.
  - It falls back to A's answer with a note when there is no key, the service is offline, the
    request times out, or validation rejects everything.
- An LLM is never needed for the panel to work.

### 6.4 Properties

- **Strengths:**
  - It reads names and notes ("vendor", "sign-off", "waiting for") and spots
    external-dependency risk the rules cannot.
  - It proposes moves outside the M1–M9 catalogue, which the engine still has to verify.
  - It answers free questions ("what's the safest way to pull the release in a week?").
  - Its briefing reads like a PM wrote it.
- **Limits:**
  - It needs a network connection, which the offline packed build does not have.
  - It costs money per call and takes seconds, not milliseconds.
  - It is not deterministic, so tests pin the validator and the digest, not the model.
  - Plan text leaves the machine, which needs a data-policy decision.

## 7. Comparison and recommendation

| | A: internal engine | B: LLM on top of the engine |
|---|---|---|
| Numbers (finish, float, P80) | Engine | Engine (the LLM never supplies a number) |
| Warnings | P/S/H rules | Same rules, re-ranked and explained with context from names and notes |
| Suggestions | Catalogue M1–M9, searched | LLM ideas + catalogue, all verified by the engine |
| Works offline / packed | Yes | Falls back to A |
| Cost per use | None | Tokens; about 3–6k in, 0.5–1.5k out per ask after §6.2 (estimate) |
| Speed | Milliseconds | Seconds |
| Deterministic, unit-testable | Fully | Digest and validator yes; model output no |
| Build size | Medium (facts, rules, SRA, optimiser) | A, plus digest, budget, adapter, validator |

**Recommendation: build A as the core, then add B as an optional layer.** B cannot be safe
without A's facts, simulator and validator, so building B first would mean building most of A
anyway, hidden inside it.

| Phase | Scope | Worth it by itself? |
|---|---|---|
| 1 | `facts.ts` + P/S/H rules + Assistant panel (warnings only, dismiss) | Yes. Early warning, the biggest gap today |
| 2 | Best/Worst estimates + Monte Carlo forecast: P50/P80, on-time %, criticality index | Yes. Turns "late" into "how likely" |
| 3 | Moves M1, M2, M4, M5, M8 + optimiser + preview/apply | Yes. The safe moves |
| 4 | Moves M3, M6, M7 (trade-off moves, always flagged) | Adds compression |
| 5 | LLM seam: digest, budget, validator, provider interface, `none` + `mock` providers, orchestrator, usage log | Yes, for testing. The LLM is ready to plug in |
| 6 | A real provider adapter, once one is chosen | Adds context and conversation |

The detailed to-do list is in §10.

## 8. Impact assessment

### 8.1 Data (`server/schema.sql`)

The design needs very little new data.

- **`assistant_dismissal`** (key, rule, dismissed_at): the same pattern as
  `conflict_resolution`.
- **Three-point estimate** (decided in §9): `task.duration_low` and `task.duration_high`, in
  working days, shown as the **Best** and **Worst** columns.
  - The rule is `duration_low ≤ duration ≤ duration_high`. NULL means the defaults in §5.3.
  - These are estimates and are **never read by `scheduleProject`**. Only the forecast reads
    them, the same way baselines are kept apart from scheduling.
  - Like people, they are **not plan state**. An edit that touches only Best/Worst skips
    `replan`, cannot move a date, and shows no impact banner. They are not in `TaskFields`.
  - A summary has none of its own (`refuseSummaryFields`); its range is the forecast's
    roll-up.
  - They are written to and read from CSV as `best` and `worst` (also `optimistic` and
    `pessimistic`). MSPDI keeps them in extended attributes, so MS Project's PERT fields
    round-trip where it can.
  - A PM who never types them still gets a forecast.
- **`assistant_setting`** (one row per key):
  - thresholds: near-critical 2 wd, long task 20 wd;
  - Monte Carlo runs;
  - for B: provider id, the model for each tier, the token budget and the privacy switches.

  The endpoint and the API key are **not** stored here; they live only in the environment.
- **`assistant_llm_log`** (B): tokens in/out/cached, latency, provider, fallback reason. No
  prompt text, so no plan data is kept.

### 8.2 Code

| Where | Change |
|---|---|
| `shared/schedule.ts` | Export the index-based forward pass so the forecast can reuse it. Behaviour unchanged |
| `shared/assistant/*` | New: `facts`, `rules`, `forecast`, `moves`, `optimise` (A); `digest`, `budget`, `validate` (B). All pure |
| `client/components/Plan.tsx` | The "should have started" check moves to rule P3. The mark stays, and reads from the finding |
| `server/routes.ts` | `GET /api/projects/:id/assistant`, dismiss/restore routes, and (B) `POST …/assistant/ask`. **No new write path for tasks**: applying uses the existing routes |
| `server/llm/*` | New (B only): `provider.ts` (the interface), `orchestrate.ts`, `providers/none.ts`, `providers/mock.ts`; later one real adapter |
| `server/schema.sql`, `server/db.ts` | New tables and the two task columns, with a migration on start |
| `client/components/Plan.tsx`, `client/planIO.ts` | Best/Worst columns and editor fields; CSV and MSPDI read and write |
| `client/components/Assistant.tsx` | New panel in the Plan view: forecast card, findings list, suggestions with Preview / Apply / Why |
| `tests/` | Rule fixtures per P/S/H rule; forecast determinism under a fixed seed and bounded runtime; optimiser never proposes a new open double-booking (randomised plans, like `smartLayout.test.ts`); digest round-trip and size; validator rejects bad codes, loops and summary writes |

### 8.3 Rules the build must keep (for CLAUDE.md when built)

- **The assistant never writes a task, link or booking.** A suggestion is change ops. It
  previews and applies through the existing routes and therefore through `replan`.
- **Risk numbers come from `shared/` only.** No float, span or clash maths in the panel or in
  a route. The LLM's numbers are never displayed.
- **Every assistant loop is bounded**: Monte Carlo runs, beam width and depth, `planProject`
  calls per request, and LLM tool turns.
- **The forecast is seeded and takes the status date as input**, so the same plan on the same
  day gives the same answer.
- **Colour.** No new hues.
  - Findings use ink weight and the existing warning mark.
  - `--alarm` stays on double-bookings only. S4 points at the clash; it does not re-colour it.
  - Suggestions that clear a clash say so in words, with `--resolved` green for "cleared" in
    the preview, as the impact banner already does.
- **Durations stay working days, holds stay calendar days.** Monte Carlo samples working-day
  durations. Clashes are still counted by `detectConflicts` on calendar days.

## 9. Decisions

Answered 2026-09-30.

| Question | Decision |
|---|---|
| Long-task threshold (H5) | **20 working days**, the 8/80 rule. It is a setting |
| Near-critical threshold (S1) | 2 working days (the default; a setting) |
| Three-point estimates | **Yes.** Optional Best/Worst columns (§8.1). Defaults cover tasks without them |
| LLM provider and data policy | **Not decided.** Build a provider-neutral seam (§6.3). The `none` provider is the default, so nothing leaves the machine until a provider is chosen and turned on. Privacy switches default to strictest: people pseudonymised, other projects anonymised, notes off |
| Scope | **One project at a time.** Clashes with other projects are still seen, because S4 and the optimiser use the team's whole booking set through `conflictsFor`, but only this project's plan is changed |

## 10. Build plan (to-do)

Each phase ends with `npm test`, `npm run typecheck` and a check in the real UI (headless
Chrome, CLAUDE.md "Testing the UI"). Each phase is committed on its own and is useful by
itself.

### Phase 0: groundwork (built 2026-09-30)

- [x] Export the index-based forward pass from `shared/schedule.ts`: durations in, ES/EF out.
      `scheduleProject` keeps its API, and the existing tests pass unchanged.
- [x] Add a seeded PRNG in `shared/assistant/random.ts` (mulberry32 or similar) with a test
      that the same seed gives the same sequence.
- [x] Add the `assistant_setting` table with defaults, and a `GET/PATCH /api/assistant/settings`
      route.
- [x] Add a CLAUDE.md section, "Smart assistant", holding the rules from §8.3.

### Phase 1: warnings (built 2026-09-30)

- [x] `shared/assistant/facts.ts` builds `PlanFacts` from a `PlanOutcome`, baseline,
      resources, open conflicts and the status date.
- [x] `shared/assistant/rules.ts`: rules P1 (deterministic lateness only until Phase 2),
      P2–P7, S1–S6 and H1–H6, each a pure function returning findings.
- [x] Severity is likelihood × impact, and impact is days past float or target scaled by
      priority.
- [x] Add a finding key and the `assistant_dismissal` table, with dismiss/restore routes. A
      dismissed finding comes back when its key changes.
- [x] Add `GET /api/projects/:id/assistant`, returning `{ findings, forecast: null, suggestions: [] }`.
- [x] `client/components/Assistant.tsx`: a panel in the Plan view.
  - Findings are grouped by Progress, Structure and Hygiene and sorted by severity.
  - Each finding has a sentence, evidence, "show me" (select and scroll to the tasks) and
    Dismiss.
- [x] Move "should have started" to rule P3. The row mark reads from the finding.
- [x] Tests: one fixture plan per rule, one that triggers it and one that does not. Dismiss
      keys must be stable across replans.

Built as: `shared/assistant/facts.ts` and `rules.ts` (with `AssistantReport`), `server/assistant.ts`,
`GET /api/projects/:id/assistant?date=`, `POST …/assistant/dismiss` and `…/restore` (`{ key }`),
and the `assistant_dismissal` table. The panel is a drawer beside the plan, opened by
**Assistant** in the plan header, which also shows the count of open warnings. Severity is a
word (High ≥ 15, Medium ≥ 8, Low) and the weight of the card's edge, never a hue. **Show**
clears the find box and "critical only", opens collapsed summaries, and scrolls to the rows,
marking them for a moment in the focus colour. P1 is on the deterministic finish until Phase 2.

### Phase 2: three-point estimates and the forecast (built 2026-09-30)

- [x] Add columns `task.duration_low` and `task.duration_high` with a migration in
      `server/db.ts`. Check `low ≤ duration ≤ high`, and refuse them on a summary.
- [x] Add a task-route path for Best/Worst-only edits that **skips `replan`**, like
      `assign`. Test that it moves no date and makes no auto booking.
- [x] Add Best/Worst columns in the task table (hidden by default, toggled like the other
      optional columns), editor fields, and CSV and MSPDI read/write in `client/planIO.ts`.
- [x] `shared/assistant/forecast.ts`:
  - Monte Carlo over the forward pass: triangular or PERT sampling, default ranges by state,
    remaining share for in-progress tasks.
  - Output: P50, P80, on-time %, criticality index, sensitivity.
- [x] Keep it bounded: a fixed number of runs, the seed from the plan hash, and a server-side
      cache by plan hash.
- [x] Rule P1 switches to P80. The panel gets a forecast card with P50/P80, on-time %, "N
      critical tasks use default ranges", and the top tasks by criticality.
- [x] Tests:
  - With the same plan and seed, the forecast is identical.
  - With zero-width ranges, P50 = P80 = the CPM finish.
  - Widening a critical task's Worst moves P80 later.
  - A 300-task plan runs within its time budget.

Built as: `shared/estimates.ts` (the rule and the range), `shared/assistant/forecast.ts`, the
**Best** and **Worst** columns (Show ▸ Best and Worst columns) and editor fields, CSV `Best`/`Worst`
(also read as optimistic/pessimistic), and MS Project's Duration1/Duration3 extended attributes.
Where it differs from the plan:

- **No server cache.** At 1,000 runs a forecast takes about 5 ms at 50 tasks, 9 ms at 300 and
  30 ms at 1,000 (measured), so it runs on every report. The seed comes from the plan, so the
  answer is still stable.
- **The status date is the data date.** Unfinished work is not forecast before it: an unstarted
  task starts no earlier than the status date, and a started one runs its remaining work from it.
  So the card shows **From today** beside **Planned** when late work has pushed the finish.
- **Triangular** sampling, not PERT-beta. It is simpler and its tail is heavier, which errs
  towards caution.
- **Criticality** traces each run's driving path back from the finish. That is the set of tasks
  that actually set the finish in that run, without a backward pass per run.
- A duration changed after an estimate was typed keeps its estimate; the range stretches to
  hold the new duration (`rangeOf`). A later edit to Best or Worst is checked against it.
- The MS Project field IDs follow its PERT analysis fields (Duration1 optimistic, Duration3
  pessimistic). They round-trip through this app; they are not yet checked against a file
  saved by MS Project itself.

### Phase 3: safe suggestions (built 2026-09-30)

- [x] `shared/assistant/moves.ts`: candidate generators for
  - M1: level within free float;
  - M2: switch to another environment of the same kind;
  - M4: drop a driving `not_before`;
  - M5: drop a redundant link by transitive reduction;
  - M8: add a buffer milestone sized P80 − P50.

  Each move is expressed as existing change ops, in task codes.
- [x] `shared/assistant/optimise.ts`:
  - A lexicographic objective (§5.4) and a beam search: width 3, depth 3, ≤ 40 candidates per
    step, ≤ 500 `planProject` calls.
  - A short Monte Carlo on the finalists only.
  - Up to 3 alternative plans.
- [x] Every suggestion carries a plan version. On Apply, the preview is re-run first if the
      plan has changed.
- [x] Panel: each suggestion shows its reason and trade-off.
  - **Preview** opens the existing impact banner (`POST /api/tasks/preview`).
  - **Apply** runs through the existing routes with Undo.
  - Moves inside one plan can be accepted one at a time.
- [x] Tests:
  - On randomised plans (like `smartLayout.test.ts`), a suggestion **never makes a new open
    double-booking** and never makes P80 later.
  - Applying a suggestion through the routes gives exactly the previewed dates.
  - Accepted double-bookings stay accepted after an M1/M2 apply, because auto-booking ids are
    kept.

### Phase 4: trade-off suggestions (built 2026-09-30, with Phase 3)

- [x] Add moves M3 (fast-track, overlap ≤ 50%), M6 (crash: "−N days needs about +M
      person-days") and M7 (split a long task). These always carry a trade-off, are ranked
      below the safe moves, and only appear in the "Aggressive" alternative.
- [x] Add M9 as action items, not plan changes: blocked critical tasks with an escalation
      line.
- [x] Tests: fast-track never overlaps more than 50%, M7 never proposes a split on a summary,
      and a trade-off move never appears in the "Safe" plan.

Built as: `shared/assistant/moves.ts` (M1–M7 as change ops), `shared/assistant/optimise.ts` (the
search, `suggest`, `planVersion`), `GET /api/projects/:id/assistant/suggestions`,
`POST …/assistant/preview` and `POST …/assistant/apply` (`{ ops, version }` → `{ plan, undo }`),
and the **Better plans** section at the foot of the drawer. Where it differs from the plan:

- **The search runs when asked** (Find a better plan), not with every report: it may schedule
  the plan hundreds of times. It runs in well under a second on the demo plans.
- **The optimiser is handed the save's own `applyChange`** (`SearchContext.apply`), so a
  candidate is refused by exactly the rules a save refuses it by. Tests hand it a small stand-in.
- **Apply is one endpoint, not a sequence of task calls.** A split (M7) is an update and a
  create, and must be all or nothing. The endpoint runs the same `applyChange` → `writeState` →
  `replan` path as a hand edit, in one transaction. It returns the ops that undo it, which the
  banner's Undo posts back.
- **M8 is advice, not a buffer task.** A task holding the buffer would be forecast as work, so
  the P80 would move out by the buffer and P1 would warn about the protection itself. The
  advice sizes the buffer (P80 − P50) and says whether it fits before the target.
- Accepted double-bookings stay accepted after an apply because apply ends in `replan`, which
  keeps auto booking ids (`reconcileBookings`). That guarantee is the existing one; it is not
  tested again here.

### Phase 5: LLM seam (no provider yet)

- [ ] `shared/assistant/digest.ts`:
  - Prune to critical, near-critical and flagged tasks and their predecessors; collapse the
    rest by WBS branch.
  - Compact encoding: task codes, working-day offsets from the status date, one-letter enums.
  - Privacy switches, with pseudonyms mapped back after the answer.
- [ ] `shared/assistant/budget.ts`: estimate tokens and degrade in 4 steps until the digest
      fits the budget.
- [ ] `shared/assistant/validate.ts`: turn LLM moves into change ops, then check codes,
      loops, summary fields and the objective against engine A's result. Record why each
      rejected move was rejected.
- [ ] `server/llm/provider.ts` (interface), `orchestrate.ts` (segments, tool loop ≤ 4 turns,
      capability fallbacks, one repair retry, timeout, fallback to A), and
      `providers/none.ts` and `providers/mock.ts`.
- [ ] Add the `assistant_llm_log` table and `POST /api/projects/:id/assistant/ask`. Show
      "Ask" in the panel only when the provider is not `none`.
- [ ] Answer cache by `hash(digest + question)`, and delta digests for follow-up questions.
- [ ] Tests:
  - Digest round-trip: codes and offsets map back to the same tasks and dates.
  - A 150-task fixture's digest stays under the budget.
  - Privacy: no person or other-project name appears when the switches are on.
  - Validator: rejects bad codes, loops, summary writes and a move that makes a new clash.
  - Orchestrator with `mock`: tool loop, repair retry, and fallback on timeout.

### Phase 6: a cloud provider (when chosen)

- [ ] Write `server/llm/providers/<name>.ts` on `fetch`. Map segments to its caching, tools to
      its tool format, and the schema to its structured output. Declare its `caps`.
- [ ] Set up environment variables and a settings entry, then run a contract test of the
      adapter against recorded responses. Check that `usage` is logged, including cache
      reads.
- [ ] Update `npm run pack` notes: the packed build works offline with `none`, and turning on
      a provider needs the environment variables on the target machine.
- [ ] Measure: compare tokens per ask from `assistant_llm_log` with the §7 estimate and tune
      the budget.
