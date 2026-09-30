# CLAUDE.md

Guidance for Claude Code when working in this repository.

## What this is

A booking board for delivery environments. Teams own environments (SIT, UAT, PROD, …);
projects book them for date ranges; the board surfaces **double-bookings** — stretches where
more projects hold an environment than its capacity allows. That detection is the product;
everything else supports it.

`reqs.md` holds the requirements and the answered scoping questions; `reqs/` holds later
feature requirements (task management: `reqs/simple_task_management.md`; the plan's Gantt
chart: `reqs/gantt_chart.md`; people on tasks: `reqs/resources.md`; the PM's smart assistant:
`reqs/smart_assistant.md`, which carries its build plan as a to-do list in §10).
`DESIGN.md` holds the architecture and UI design, including why things look the way they do.
`docs/gantt/` explains the Gantt chart for later work: user guide, architecture, data and API,
file formats, testing recipe, roadmap. `DESIGN.md` wins where they disagree.

## Commands

```bash
npm run dev        # API (5174) + Vite (5173)
npm start          # single process, serves dist/ + API on 5173
npm run build      # bundle client to dist/
npm run seed       # reset data/timeline.db to demo data
npm test           # vitest
npm run typecheck  # tsc --noEmit
```

Node 24+ required. No native modules: SQLite is `node:sqlite`, and the server's TypeScript
runs through Node's built-in type stripping rather than a build step.

## Layout

```
shared/   dates.ts, conflicts.ts, types.ts — pure, imported by BOTH server and client
          schedule.ts, taskHolds.ts, plan.ts — task scheduling, holds, impact (same rule)
          wbs.ts — the task outline (summaries), read depth-first
          assistant/ — the smart assistant: settings, seeded random, later rules and forecast
server/   Express routes over SQLite; schema.sql is the source of truth for the data model
client/   React board; layout.ts holds the time scale and lane packing (pure, tested)
          gantt.ts — the plan chart's scale, zoom, drag maths, progress (pure, tested)
          planIO.ts — CSV and MS Project XML in and out (pure, tested)
tests/    Vitest over shared/ and client/layout + client/components/Board's pure exports
```

## Rules that matter here

**Dates are `YYYY-MM-DD` strings, never `Date` objects, at every boundary.** All arithmetic
lives in `shared/dates.ts` and works in UTC. A plan date is a label on a calendar, not an
instant; parsing as local time makes releases appear to shift by timezone.

**Effort and occupancy are deliberately different, and conflating them breaks conflict
detection.** Effort counts working days (weekends and holidays skipped) and drives durations
and date snapping. Occupancy counts calendar days, because a Friday-to-Monday booking holds
the environment through the weekend. `detectConflicts` must stay on calendar days.

**Conflict logic belongs in `shared/conflicts.ts` only.** Both sides import it so that a
future drag preview and the server agree by construction. Do not reimplement overlap checks
in a component or a route.

**Colour is spent on one thing.** `--alarm` is for double-bookings and nothing else;
environment hues deliberately avoid the red family so the alarm stays pre-attentive. Before
adding a new coloured element, check `DESIGN.md` §6 and §11. The one addition is
`--resolved` (pale green), for a double-booking someone has accepted. The today line and
flag are red too (`--today`, by request); keep them thin so they never read as a clash. So is
the outline of a critical bar on the Gantt chart and in the portfolio, and a critical arrow on
the chart, in the network and in the portfolio (`--critical-outline`, by request): lines only, never a fill or hatch.

**Resolved double-bookings still exist; they just stop alarming.** A resolution is keyed by
`conflictKey` (environment + exact booking ids, no dates), stored in `conflict_resolution`,
and stamped on by `applyResolutions` on both sides. `/api/board` returns the keys as
`resolved` because the drag preview recomputes conflicts and must re-stamp them. Counts, the
red outline, rail markers and lane status all use `openConflicts`; the hatch and drawer show
every conflict, resolved ones in green.

**A one-day booking is a CUSTOM event** (`effectiveKind` in `shared/bookings.ts`), so it can
carry a marker icon. RELEASE keeps its kind. The server applies it on every write and
`server/db.ts` migrates older rows on start; the dialog and the long-press plan apply it too,
so what the form shows is what gets saved.

**Timeline text is NULL until someone writes it.** A bar says `timeline_text` when set,
else the label and note (`defaultTimelineText` in `shared/bookings.ts`). The dialog shows the
default filled in, and `timelineTextToStore` saves NULL when it is blank or unchanged, so an
untouched booking keeps following project renames and note edits. Never store the default.

**Conflicts are computed over the team's whole environment set, not the filtered subset.**
Hiding a lane must not make its double-bookings disappear (see `/api/board`).

## Tasks book environments

`DESIGN.md` §16 has the design. The rules that break things when forgotten:

**A booking's `start_date`/`end_date` are the effective span; `manual_start`/`manual_end` are
what someone booked.** Effective is the manual span stretched over the task hold it overlaps
(`effectiveSpan`), never shorter than manual. NULL manual dates mean an auto booking made by
tasks alone. Never write an effective span into the manual columns: the booking dialog edits
manual dates and sends dates only when they changed, or a note edit would lock a stretch in.

**Every write that can move a plan ends in `replan`** (`server/plan.ts`), in the same
transaction: tasks, links, project start, booking dates, holidays. It is the only writer of
task dates, hold columns and auto bookings. A new route that changes any of those and skips
it leaves the board wrong until something else replans.

**Scheduling and holds live only in `shared/`.** The preview endpoint and the drag preview
(`spanWithHold`) run the same functions as the write, so a prediction matches the save. Do
not recompute a task span, a hold or a stretch in a component or a route.

**Auto bookings keep their id** by overlap matching in `reconcileBookings`. Recreating them
on every replan would silently un-resolve every accepted double-booking that involves them.

**Holds are calendar spans; durations are working days.** Same split as bookings.

**Network arrangement is layout only.** `task.net_x/net_y` and `task_dependency.route_*`
are written by their own endpoints, never replan, and are never read by scheduling.
`writeState` deletes and reinserts a project's links on every task edit, so it copies the
route columns across; drop that and every hand-shaped arrow resets on the next edit.

**Smart Arrange is a hand arrangement, not a second automatic layout.** `client/smartLayout.ts`
returns positions and routes (with `from`/`to` anchors) that are saved through the same columns
as dragging, so every existing edit path works on them. `writeState` must copy `route_from` and
`route_to` along with the other route columns. `tests/smartLayout.test.ts` checks random plans
for lines through boxes, unrelated arrows sharing a line, and false junctions; keep all three.

**A summary task is a roll-up, not work.** A task with children (`parent_id`, `shared/wbs.ts`)
is left out of scheduling and holds; its dates, float and criticality roll up from the tasks
under it, and `checkOutline` (server/plan.ts) clears its environment. Links to or from a summary
are expanded onto its working tasks (`expandLinks`) and must be FS. The outline is read
depth-first every time (`outline`, `inOutlineOrder`); `sort_order` only orders siblings, so never
number rows by `sort_order` alone. Row numbers and MSPDI use outline order.

**A summary has nothing of its own** (`reqs/sub_tasks.md`). Its status and actuals are rolled up
by `rolledUp` in `planProject` and stored by `replan`; never compute them in a component, and
never let a write set them (`refuseSummaryFields`). Its `not_before` holds every task under it
(`inheritedFloors` in `scheduleProject`). `applyChange` hands a new summary's environment to
the sub-tasks it just gained (`passEnvironmentDown`) and gives a former summary back its rolled
length (`revertFormerSummaries`). Delete takes `children: 'lift' | 'delete'`, and a branch
delete bridges the links that cross into and out of the branch.

**TaskIDs are typed labels, not row numbers.** `task.code` is unique per project (index in
`server/db.ts`, checked in `applyChange` so a preview refuses a clash too). A create without one
gets `nextTaskCode` (count + 1, or the next free). After and CSV are written in codes; links
stay stored by `task.id`. `fillTaskCodes` backfills NULL codes on start in outline order, so
older plans read as they did. Dragging a row (`moveBefore` in `shared/wbs.ts`) is an outline
change like Alt+↑/↓ and goes through the same `outline` op.

**Link types live in the scheduler, not the chart.** `task_dependency.type` is FS, SS or FF;
`scheduleProject` applies it in both passes and in free float. A missing type reads as FS.
The After column, the chart and the files only write and draw it.

**The plan chart edits through the table's doors.** A drag or Alt+arrow on a Gantt bar becomes
`startFields` / `finishFields` (client/gantt.ts) and is saved by the same `setStart` /
`setFinish` as a typed date. Its live preview runs `planProject`, `bookingsFor` and
`conflictsFor` from shared/plan.ts in the browser, and `isManaged` (shared/taskHolds.ts) picks
the bookings exactly as the server does. Do not compute a span, a hold or a clash in
`Gantt.tsx`; the environments strip counts with `occupancyByDay` from shared/conflicts.ts.

**Baselines are snapshots.** `task_baseline` is written only by the baseline routes and never
read by scheduling or replan. Progress (`task.progress`) never moves a date either.

`task.environment_id` is `ON DELETE RESTRICT`, like bookings, and the environment delete route
refuses while tasks use it, saying how many. The network layout (`client/network.ts`) is bounded like the ruler: a
fixed number of barycentre sweeps, one pass per rank.

## People on tasks

`reqs/resources.md` has the design. The rules that break things when forgotten:

**Resources are typed as text but stored as rows.** The Who column (`Mai, Tuan Nguyen`) is only
an input and output format. `resource` holds one row per person, `task_resource` one per
assignment in the order typed. `parseResources` and `resourceKey` in `shared/resources.ts` are
the only rules for splitting (commas and semicolons, never spaces) and matching (case ignored,
accents kept). Never store the joined string; `task.assignee` was migrated and dropped.

**Assigning people is not planning.** `task_resource` is written by the task routes (`assign` in
`server/routes.ts`) in the same transaction as the task, never by `replan` or `writeState`, and
scheduling never reads it. A people-only edit skips `replan`, so it cannot move a date or
un-accept a double-booking. `resources` is not in `TaskFields` for that reason.

**Resources are global and outlive their tasks.** Typing a new name makes one (`ensureResources`);
only the Resources dialog's delete or merge removes one. A later workload view must count
**working days** over leaf tasks: do not pass people through `detectConflicts`, which counts
calendar days for environments. `[` and `]` are refused in names to keep `Mai[50%]` free for
allocation.

## Smart assistant

`reqs/smart_assistant.md` has the design and the phased to-do list (§10); tick items there as
they land. Built: Phase 0 (`forwardPass`/`indexNetwork` in shared/schedule.ts, the seeded
random source, the settings) and Phase 1 (warnings: `planFacts` in `facts.ts`, the P/S/H rules
in `rules.ts`, `server/assistant.ts`, the drawer in `client/components/Assistant.tsx`) and
Phase 2 (Best/Worst estimates in `shared/estimates.ts`, the Monte Carlo in `forecast.ts`, P1 on
its P80). The rules that break things when forgotten:

Phases 3 and 4 (better plans: `moves.ts`, `optimise.ts`, the drawer's Better plans) are built too.

**A suggestion is change ops, applied by the save's own functions.** `SearchContext.apply` is
the server's `applyChange`; `applyOps` (server/assistant.ts) runs `applyChange` → `writeState`
per op and one `replan`, in one transaction, refusing a stale `planVersion` with 409. Never give
the optimiser its own applier in production code: its verdict would drift from the save's.

**The search is bounded and lexicographic** (`BEAM_WIDTH`, `BEAM_DEPTH`, `CANDIDATES_PER_STEP`,
`SEARCH_BUDGET`). A plan with a new open double-booking is never kept, whatever else it gains;
`tests/assistantOptimise.test.ts` checks that on random plans, and that P80 never gets later.
Trade-off moves (M3, M6, M7) only enter the aggressive profile and always carry a `tradeoff`.

Phase 5 (the LLM seam: `digest.ts`, `budget.ts`, `validate.ts`, `server/llm/`) and Phase 6 (the
`anthropic` and `openai-compatible` adapters, both off by default) are built too.

**A provider adapter maps, and does nothing else.** It turns `LlmRequest` into its API and back,
throws `LlmUnavailable` for a missing key or an unreachable server, and echoes `raw` assistant
content unchanged (thinking blocks). Prompt, tools, budget, validation and fallback stay in
`orchestrate.ts` and `shared/assistant/`. Register a new one in `server/llm/index.ts` and add its
id to `LLM_PROVIDERS`. Keys and URLs come from `ASSISTANT_LLM_KEY` / `ASSISTANT_LLM_URL` only.

**The advisor advises; the engine decides.** An LLM reads `buildDigest` (never raw rows),
answers in `ANSWER_SCHEMA`, and every move it proposes goes through `judgeMoves`, the same search
as the engine's own. The panel shows engine numbers only. `advisorReply` never throws for an LLM
failure: it falls back to the engine and says why. Nothing leaves the machine with the default
provider `none`; people, other projects and notes are pseudonymised or withheld unless the
settings say otherwise, and `unmaskText` puts the names back.

**Dates in the digest are working-day offsets from the status date** (`offsetOf`,
`dateAtOffset`), both ways. The rubric in `server/llm/orchestrate.ts` explains the notation; if
you change a digest line, change the rubric's legend with it.

**The forecast runs the scheduler's forward pass on sampled durations**, over a copy of the
index network floored at the status date. It never reimplements float or link maths, and a zero-
width range must give the CPM finish (a test pins it).

**Rules read `PlanFacts`, never rows.** A new rule adds what it needs to `planFacts` and stays
a pure function; its words are templates filled with engine numbers. The Phase 5 LLM digest is
built from the same facts, so a fact computed anywhere else would split the two.

**A warning's key is its identity.** `Finding.key` is the rule and the exact things it
concerns; `assistant_dismissal` stores keys the way `conflict_resolution` does. Put a number
in the key only when a change in it should bring a dismissed warning back (P1 keys on days
late). Dismissed warnings are listed, greyed, and stop counting.

**"Should have started" is rule P3.** The row mark in the task table shows for open P3
findings from the report, not from its own check. Change the rule, not the table.

**The assistant never writes a task, link or booking.** A suggestion is a list of the existing
change ops; it previews through `POST /api/tasks/preview` and applies through the same routes,
so `replan` runs and auto bookings keep their ids.

**Risk numbers come from `shared/` only**, by calling `planProject`, `planImpact`,
`conflictsFor` and `forwardPass`. No float, span or clash maths in a panel or a route, and an
LLM's numbers are never displayed: it gives reasons, the engine gives numbers.

**`scheduleProject` runs its forward pass through `forwardPass`.** The forecast samples
durations through the same function, so a zero-width range gives the CPM finish exactly. Change
the pass in one place, never fork it.

**Every assistant loop is bounded**: forecast runs (a setting, capped), beam width and depth,
`planProject` calls per request, LLM tool turns. **Randomness is seeded** (`seededRandom`,
`seedOf`), never `Math.random`, and the status date is an input, never read from the clock in
`shared/`, so the same plan on the same day gives the same answer.

**Settings store only overrides.** `assistant_setting` holds what someone changed, as JSON;
`mergeSettings` reads it over `DEFAULT_ASSISTANT_SETTINGS` and drops a value that no longer
passes its rule. A new setting is a line in `shared/assistant/settings.ts`, not a migration.
Settings are not plan state and never replan. The LLM endpoint and key are never settings: they
come from the environment (`ASSISTANT_LLM_URL`, `ASSISTANT_LLM_KEY`), and the default provider
`none` sends nothing anywhere.

**Best/Worst estimates are not plan state**, like people: `duration_low`/`duration_high` are
not in `TaskFields`; the task routes take them as extras (`estimateFrom`, `setEstimate`), and an
edit touching only them skips `replan`, so it cannot move a date or un-accept a double-booking.
`scheduleProject` never reads them. `estimateError` is the one rule, used by the routes, the
import, the table and the editor.

## Drag-to-edit

Three files: `client/dragMath.ts` (pure span math, tested), `client/useBookingDrag.ts`
(pointer gesture), and `pendingSpans` in `App.tsx` (optimistic overlay).

**Moving preserves working-day length, not calendar length.** Dragging a five-working-day
booking across a weekend must not make it seven. Resizing clamps instead of inverting.

**Every drag result lands on working days at both ends.** That makes the server's `snapRange`
a no-op, so the preview and the saved value agree and nothing jumps on drop. If you change
snapping on either side, change it on both.

**The live preview must flow through `pendingSpans`.** The board, the conflict engine and the
drawer all read through it. An early version fed only the readout from the drag session, so
the bar moved but conflict detection did not run until after the save — the feature's whole
point, silently missing.

**Click versus drag is decided in the hook** (4px slop), never by a click handler. The bar's
`onClick` only fires for keyboard activation, detected with `event.detail === 0`.

**Long-press to book** on empty lane space books from the pressed working day to that
week's Friday (`quickSpan` in `dragMath.ts`). It is a long press, not a click, on purpose: a
click was too easy to make by accident, and with nothing on screen during the save it looked
like it had failed. The row (`BoardRow`) runs the gesture: a ghost fills in over
`LONG_PRESS_MS`, releasing then calls `createFromPlan`; moving past the slop, Escape or a
`pointercancel` abandons it, and a plain click only shows a hint toast. `planAt` in `App.tsx`
picks the booking: the lane supplies environment or project, the last-used one the other.

**The save must never look like nothing.** From release until the server answers, a
placeholder (`provisionalBooking`, id `PROVISIONAL_ID`) is injected into `preview`, so it
packs into its real lane and runs through `detectConflicts` like any bar. It is dropped once
the refreshed board contains the created id. Every such booking gets a 6s Undo toast.

Arrow keys mirror the gestures and debounce into one write. Do not drop the keyboard path:
drag-only editing would break the accessibility requirement in `DESIGN.md` §5.

## Loops that build the ruler must be bounded

A frozen tab in this app has one likely cause: a `while` in `client/layout.ts` that fails to
advance. `majorTicks` once stepped a quarter forward by one month and then re-aligned to the
quarter start, which snapped back to where it began and spun forever — Quarter view froze
every time.

Step each period by its own length (`addMonths(period, 3)` for quarters), never by a smaller
unit followed by re-alignment. Every such loop carries a `guard` counter so a future mistake
shows up as a short ruler instead of a hung browser. `addWorkingDays` and `snapToWorkingDay`
are bounded for the same reason.

Tests cover all three zooms, including a sweep over every start date in a year. When touching
the ruler or the date walk, never test only `month`.

## Packing for another machine

`npm run pack` (`scripts/pack.mjs`) builds here and produces a zip that runs on a
target Mac with only Node 24+ — no build, no install, no internet.

The bundle's `package.json` lists only production dependencies by name (`express`,
`@anthropic-ai/sdk`); a new runtime dependency must be added there too.

Two traps it exists to avoid, both of which bit during development:

**Never copy `data/timeline.db` with `cp`.** SQLite runs in WAL mode, so recent writes
sit in `timeline.db-wal`; the main file can be hours stale. In testing a plain copy
shipped week-old seed data instead of the user's real work. The script uses
`VACUUM INTO`, which writes one consistent file.

**Vendored font URLs are same-directory.** `fonts.css` is written into `dist/fonts/`
alongside the woff2 files, so `src: url(<file>.woff2)` — not `url(fonts/<file>.woff2)`,
which resolves to `/fonts/fonts/…`.

Related: the static handler in `server/index.ts` only falls back to `index.html` for
paths with no file extension. Without that, a missing asset returns HTML with a 200
and a broken path is invisible — exactly how the font bug hid.

## Testing the UI

The Chrome extension may not be connected. Headless Chrome over the DevTools protocol works
and is better for measuring: launch with `--remote-debugging-port`, drive `Runtime.evaluate`
and `Page.captureScreenshot` over a WebSocket. Measure geometry from the DOM rather than
eyeballing screenshots — a `--screenshot` capture can differ from the emulated layout width
and produce false clipping.

## Editing

Teams, projects, environments and bookings all have full create/edit/delete, through three
manager dialogs of identical shape (`client/components/Dialogs.tsx`) plus the booking dialog.
Rail row labels open the editor for the row they name.

Destructive actions use `DangerButton`, which arms on the first click, states the cascade
using server-supplied counts (`team.project_count`, `project.booking_count`, …) and disarms
itself after 4s. Do not replace it with `confirm()` — a blocking dialog freezes the page and
breaks browser automation.

Deleting a team needs `removeTeam` in `App.tsx`, not the generic `run()` helper: the board
has to be repointed before a refresh, or it queries a team that no longer exists.

A project with zero bookings still gets a board row in project mode. Without that, a newly
added project is invisible and unreachable. A project whose bookings are merely filtered out
is correctly hidden — see `buildRows`.

## Still to build

Sub-project roll-ups, saved views, bulk shift; for tasks, cross-project links (the portfolio is
read-only side by side), resource workload and levelling (`reqs/resources.md` §7). `DESIGN.md` §12 has the order.
For the assistant: a first live run of a chosen provider and the token measurement
(`reqs/smart_assistant.md` §10, Phase 6).
