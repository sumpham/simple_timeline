# Professional project management features

Status: planned 2026-10-04. Phases R (§8), A (§3), B (§4), C (§6) and D (§5) built 2026-10-04; E is not built yet. The build plan is the to-do list in §10;
tick items there as they land, as `reqs/smart_assistant.md` §10 does.

The five features, plus one change to the assistant that all of them rely on:

1. **Deadlines.** A committed date on a task that the scheduler checks, and that can make the
   task critical.
2. **Named baselines.** More than one saved plan, variance columns, and a slip chart that shows
   how the finish date has moved.
3. **Levelling people.** The assistant suggests how to remove a person's overlap, the same way
   it already removes a double-booking.
4. **Earned value.** Cost, a budget, and plain answers to "are we behind?" and "are we over?".
5. **Links between projects.** A task in one project drives a task in another, and a slip
   upstream moves the plan, and its bookings, downstream.

And:

6. **Review before applying.** Every assistant suggestion gets a **Review** button that opens a
   full page showing the plan as it would be: the to-be timeline, the environments, people's
   workload, the budget and other projects. You check it there and press **Apply** only when
   you're satisfied (§8).

The visual mockups are in `reqs/pm_features_mockups.html`, also published as an artifact. This
document holds the decisions. Where the two disagree, this document wins.

---

## 1. Where we start

| Already built | Where |
|---|---|
| CPM with FS/SS/FF, lag, summaries, milestones, total and free float | `shared/schedule.ts` |
| One baseline per project, ghost bars, finish variance on the Gantt label | `task_baseline`, `Gantt.tsx` |
| Progress, actual start and actual end | `task.progress`, `task.actual_*` |
| People on tasks, and person overlap detection | `task_resource`, `shared/workload.ts` |
| Monte Carlo P80, warning rules, a bounded search for better plans | `shared/assistant/` |
| A read-only portfolio with every plan side by side | `Portfolio.tsx` |

What is missing: a date someone has committed to below the project level, a record of how the
plan has drifted, a way to fix a person's overlap, any notion of money, and any link between
projects.

## 2. Design direction

These features extend an instrument that already has a strong identity (DESIGN.md §5–§11), so
the job is to fit into it, not to restyle it. The direction for all five:

**Answer in words first, numbers second.** A PM who doesn't know earned value should still read
"6% behind schedule, 3% over budget" before they see "SPI 0.94". Each new panel opens with a
sentence written from the engine's numbers, as the assistant's findings already do. The
indices sit under it, with a tooltip that defines them.

**Red stays spent.** None of the five features gets a new alarm colour.

- A missed deadline uses the existing `late-tag` treatment and an ink marker.
- An over-allocated person is shown by weight (a heavier, taller block) and a `2×` count. This
  is the same rule as assistant severity: "a word and a weight, never a hue".
- Cost lines on the chart are told apart by stroke style (solid, dashed, dotted) and by a
  label at the end of each line, never by hue alone.
- The only red is what already exists: double-bookings, the today line, and critical outlines.

**Put things where the question is asked.** Nothing gets a page of its own if it can sit where
people already look.

- Deadlines are a column, a marker on the bar, and a field in the editor.
- Baselines live in the plan's facts row as a "Compare with" picker.
- Levelling is a filter in the assistant drawer.
- Cross-project links are typed in the After column, like any other link.
- Only earned value gets a new tab (**Budget**), because it needs a chart and a status date.

**Every preview is the save.** Levelling suggestions, deadline edits and cross-project links
all go through the existing preview route and `ImpactBanner`. Before anything is saved, people
see "moves the finish +3d, new double-booking in UAT", worked out by the same functions that
will do the save.

### 2.1 Defaults I rejected

1. **A KPI tile row for earned value** (four big numbers: SPI, CPI, EAC, VAC). Replaced with
   two verdict sentences and one chart. Tiles make every number equally loud. The real
   question is "behind or ahead, over or under", and that is two answers, not four numbers.
2. **A legend under the S-curve.** Each line is labelled at its right-hand end, so there is
   nothing to look up.
3. **A red heat map for workload.** Red would compete with double-bookings. The workload strip
   uses block height and ink weight instead.
4. **A separate "Dependencies" page for cross-project links.** Links are already typed in the
   After column, and a link to another project is still a link. Giving it a new home would
   teach a second way to do the same thing.
5. **A baseline manager dialog.** A popover on the facts row is enough: pick one to compare
   against, save the current plan as a new one, rename or delete. The dialog pattern in
   `Dialogs.tsx` is for things with many fields; a baseline has one, its name.

---

## 3. Deadlines

### 3.1 What it does

A task can carry a **deadline**: the date it must finish by. Unlike `not_before`, a deadline
never moves the task. It changes the task's **late finish**, and through that its float.

- A task that finishes on its deadline has zero float and is critical.
- A task that finishes after its deadline has negative float, and the row says
  "3 working days past deadline".

MS Project behaves the same way, so plans imported from it keep their meaning.

### 3.2 Data

- `task.deadline TEXT NULL`, a `YYYY-MM-DD` label like every other date.
- It is plan state: it goes in `TaskFields`, every edit to it ends in `replan`, and it changes
  `total_float` and `critical`.
- On a summary it is allowed. It applies to every working task under it, the same way
  `not_before` is inherited (`inheritedFloors`): add `inheritedDeadlines`, which takes the
  earliest deadline on the task or any of its ancestors.

### 3.3 Scheduling (`shared/schedule.ts`)

- In the backward pass, a task's starting late finish becomes
  `min(finishIndex, deadlineIndex + 1)`, before successors are considered. Remember that `ef`
  is exclusive.
- Nothing else in the pass changes. `forwardPass` doesn't read deadlines, so the forecast's
  zero-width test (CLAUDE.md "Smart assistant") still pins the CPM finish.
- `TaskSchedule` gains `deadline_slack: number | null`: the working days from finish to
  deadline, negative when late.

### 3.4 Assistant

- New rule **P8, "Deadline at risk"**: the share of forecast runs in which the task finishes
  after its deadline.
  - The forecast records the sampled finish only for tasks that have a deadline, so the cost
    stays bounded by the number of deadlines.
  - The key is `P8:<task>:<days late at P80>`, so the warning comes back if it gets worse
    after being dismissed.
- P1 is unchanged: it stays about the project target.

### 3.5 UI

- **Table:** a `Deadline` column, off by default and in the column picker. A late row shows the
  existing `late-tag` reading "3d past deadline".
- **Gantt:** a small ink chevron hangs from the top of the row at the deadline date, with a
  title tooltip ("Deadline Fri 14 Nov").
  - If the bar runs past it, the overrun is drawn as a thin ink bracket under the bar, with a
    `+3d` label.
  - This is never hatched, because hatching means a double-booking.
- **Editor:** a date field with two quick chips, **Use current finish** and **Clear**.
  "Use current finish" is the common move: "commit to what the plan says now".
- **Files:** CSV gets a `Deadline` column. MSPDI maps it to `<Deadline>` both ways.

---

## 4. Named baselines

### 4.1 What it does

A project keeps up to **10** named baselines, for example "Approved plan", "After CR-12" and
"Sprint 9". One of them is the **comparison baseline**. That one drives:

- the ghost bars,
- the variance columns,
- the assistant's baseline facts,
- earned value.

### 4.2 Data

```sql
CREATE TABLE IF NOT EXISTS baseline (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  saved_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  finish     TEXT    NOT NULL,          -- the project finish when saved, for the slip chart
  UNIQUE (project_id, name)
);
-- task_baseline gains baseline_id; PK becomes (baseline_id, task_id).
-- It also gains duration and cost (§6), so variance and earned value read one snapshot.
ALTER TABLE project ADD COLUMN compare_baseline_id INTEGER REFERENCES baseline(id) ON DELETE SET NULL;
```

**Migration (`server/db.ts`):** each project with `task_baseline` rows gets one baseline named
"Baseline", with `saved_at = project.baseline_at`, and becomes its comparison baseline.
`baseline_at` stays readable for one release, then goes.

Baselines remain snapshots: written only by the baseline routes, never read by scheduling or
`replan` (CLAUDE.md "Baselines are snapshots").

### 4.3 Routes

| Route | Does |
|---|---|
| `GET /api/projects/:id/baselines` | List: id, name, saved_at, finish, task count |
| `POST /api/projects/:id/baselines { name }` | Snapshot now. Refuses an 11th, saying which is oldest |
| `PATCH /api/baselines/:id { name?, compare? }` | Rename, or make it the comparison baseline |
| `DELETE /api/baselines/:id` | Delete. If it was the comparison baseline, the newest remaining one takes over |

### 4.4 Variance (`shared/variance.ts`, new, pure)

`varianceOf(task, schedule, snapshot, holidays)` returns `{ start, finish, duration }` in
working days. A positive number means later or longer. It is the one rule, used by:

- the table columns (`Start var`, `Finish var`, `Dur var`, all in the column picker),
- the Gantt label (which already shows finish variance, and moves onto this function),
- the assistant facts.

### 4.5 UI

The facts row's `Baseline` entry becomes **Compare with [Approved plan ▾]**, plus the finish
variance against it ("+6d").

The picker opens a popover containing:

- **The slip chart:** one dot per baseline, oldest on the left, plotted at that baseline's
  finish date, with today's forecast finish as an open dot at the right. A rising line is a
  plan that keeps slipping, visible in a second. This is the standard milestone trend chart,
  drawn small.
- **The list:** name, saved date, finish. Click a row to compare with it; the comparison
  baseline is marked with a filled radio. Rename is inline (double-click, or the pencil).
  Delete uses `DangerButton`.
- **Save current plan as…:** a name field prefilled with "Baseline 2026-10-04", and **Save**.
  The toast says "Saved baseline “…”".

The old **Save baseline / Update baseline** buttons in the table toolbar become
**Save baseline…**, which opens the same popover with the name field focused.

---

## 5. Levelling people

### 5.1 What it does

`shared/workload.ts` already finds a person on two tasks at once. Levelling suggests how to
remove it:

1. Delay the task with more float until the other finishes. This is free when it stays within
   float.
2. Failing that, delay the one with the smaller effect on the finish, and say how much it
   costs.

The assistant suggests; people apply. Nothing levels automatically, because levelling a plan
someone did not ask about is the fastest way to lose their trust.

### 5.2 Engine

- `PlanFacts` gains `overlaps: OverlapFacts[]`, built in `planFacts` from `shared/workload.ts`
  over this project's leaf tasks and people's work in other projects (`elsewhere`, already
  loaded by the plan route).
- New move **ML, "Level a person"** in `shared/assistant/moves.ts`:
  - It proposes `{ op: 'update', id, fields: { not_before } }` on the later-starting or
    floatier task, set to the working day after the other task ends.
  - Within float, `tradeoff` is null and the move enters the balanced profile.
  - Beyond float, it carries a `tradeoff` ("finish +2d") and enters only the aggressive
    profile, like M3/M6/M7.
- It is judged by the same search. The lexicographic order gains one term after "no new open
  double-booking": **fewer person-overlap days**. So a plan that fixes a person by causing a
  double-booking is still never kept.
- `DISRUPTION.ML = 2`, so it ranks just after M1.
- Rule **H7, "Person on two tasks"** turns each overlap into a finding, keyed by
  `H7:<resource>:<taskA>:<taskB>`. The person filter's overlap mark (built 2026-10-01) reads
  from it, as the "should have started" mark reads from P3.

### 5.3 UI

- **Workload strip:** a fifth toggle in the Gantt's Show menu, **People**, which draws one row
  per person under the environments strip.
  - Each working day is a cell. Load 1 is a light block. Load 2 or more is a full-height block
  in ink with the count (`2×`).
  - Hovering a cell names the tasks. Clicking selects them in the table.
- **Assistant drawer:** findings and Better plans get a filter row
  (**All · Environments · People · Dates**).
  - **Level people** at the top of the People filter runs the search with ML moves only and
    lists what it found.
  - Each suggestion has **Review**, which opens the review page (§8) on the People view.
- **Empty state:** "Nobody is on two tasks at once." in `--muted`.

---

## 6. Earned value

### 6.1 What it does

It answers two questions at a status date: **are we behind?** and **are we over?** It also
says where the money is heading.

### 6.2 Data

Cost is not plan state. Like people and Best/Worst estimates, it is left out of `TaskFields`,
and an edit that touches only cost skips `replan`.

- `resource.rate REAL NULL`: cost per working day.
- `task.fixed_cost REAL NULL`: money that isn't time, such as licences or a vendor invoice.
- `task.actual_cost REAL NULL`: entered when known. When it is NULL, the actual cost is
  *estimated* as working days of actual work so far × rates, and the UI says "estimated".
- `project.currency TEXT NOT NULL DEFAULT 'EUR'`, used only for display.
- `task_baseline.cost REAL` and `task_baseline.duration INTEGER` (§4.2), so the budget is the
  snapshot's and not today's.

Planned cost of a task = `duration × Σ rate of its people + fixed_cost`. People are counted as
full time; allocation (`Mai[50%]`) is the later feature `resources.md` §7 keeps room for.

### 6.3 Engine (`shared/earnedValue.ts`, new, pure)

`earnedValue({ tasks, schedule, snapshot, resources, statusDate, holidays })` returns:

- BAC, PV, EV and AC at the status date,
- SV, CV, SPI and CPI,
- EAC (`BAC / CPI`), ETC and VAC,
- a weekly series of PV, EV and AC for the chart (bounded: one point per week, with a guard
  counter like the ruler's loops),
- the same figures per summary task.

The rules:

- PV spreads each task's baseline cost evenly over its baseline **working days**.
- EV is `progressOf(task) × baseline cost`. It uses the existing progress rule, so a task with
  no typed progress earns by its status.
- Only leaf tasks are counted. Summaries roll up by sum.
- The status date is an input, never read from the clock (same rule as `shared/assistant/`).
- No baseline means no earned value. The function returns `{ missing: 'baseline' }`.

### 6.4 UI: the **Budget** tab

Tabs become **Tasks · Network · Budget · Portfolio**.

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ Status date [Fri 3 Oct ▾]    Compare with [Approved plan ▾]        EUR ▾      │
├───────────────────────────────────────────────────────────────────────────────┤
│ 6% behind schedule.  Work worth €8,400 planned by now hasn't been done.      │
│ 3% over budget.      Done work cost €4,100 more than planned.                │
│ At this rate it finishes at €183,500, €5,500 over the €178,000 budget.       │
├──────────────────────────────────────────────────┬────────────────────────────┤
│                                     ╱ Planned    │ Schedule  SPI 0.94  ▁▁▁▆█  │
│                              ╱‥‥‥‥‥  Actual      │ Cost      CPI 0.97  ▁▁▁▅█  │
│                       ╱─────── Earned            │ Budget    €178,000          │
│               ╱──────                            │ Forecast  €183,500 (+€5,500)│
│ ─────────────                     │status        │ Spent     €135,700 est.     │
├──────────────────────────────────────────────────┴────────────────────────────┤
│ Summary task        Budget     Earned    Spent     Schedule    Cost           │
│ Build                €92,000   €61,000   €64,200   ▮▮▮▮▮▯ 0.96  ▮▮▮▮▯ 0.95    │
│ Test                 €54,000   €18,500   €17,900   ▮▮▮▮▯▯ 0.88  ▮▮▮▮▮ 1.03    │
└───────────────────────────────────────────────────────────────────────────────┘
```

- **Verdict lines** come first. They are templates filled from engine numbers, never free
  text. "On schedule" and "on budget" read within ±2%; outside that the line names the
  percentage.
- **Chart:**
  - Planned is `--muted` dashed, Earned is `--ink` 2px solid, Actual is `--ink` 1.5px dotted.
  - Each line has a label at its end; there is no legend.
  - The status date is a vertical ink hairline. The today line keeps its red only on time
    charts, so this is not it.
- **Per summary:** a bullet bar for each index with 1.0 marked. Below 0.9 the number turns
  bold, by weight and not hue.
- **Costs are entered** in a new `Cost` column in the table (off by default), in the task
  editor, and as `Rate per day` in the Resources dialog.
- **Empty states:**
  - No baseline: "Earned value compares against a baseline. Save one to start." with
    **Save baseline…**.
  - No rates or costs: "Add a rate to people or a cost to tasks to see a budget." with
    **Open Resources**.
- **Files:** CSV gets `Cost` and `Actual cost`. MSPDI maps `<Cost>`, `<FixedCost>`,
  `<ActualCost>` and the resource `<StandardRate>`, converting per hour ↔ per day at 8h.

---

## 7. Links between projects

### 7.1 What it does

A task in one project drives a task in another: "Payments API ready → Mobile release". When
the upstream task slips:

- the downstream plan moves,
- its auto bookings move with it (keeping their ids),
- any double-booking that creates shows up on the board.

### 7.2 Data

```sql
CREATE TABLE IF NOT EXISTS project_link (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  predecessor_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  successor_id   INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL DEFAULT 'FS' CHECK (type IN ('FS','SS','FF')),
  lag            INTEGER NOT NULL DEFAULT 0,
  UNIQUE (predecessor_id, successor_id)
);
```

This is a separate table, on purpose. `writeState` deletes and reinserts a project's
`task_dependency` rows on every edit. Cross-project links in that table would be wiped by an
edit in either project, and the route columns' lesson (CLAUDE.md) says that kind of bug is
silent.

Both tasks must be working tasks in different projects of the same team; links to a summary
are refused as they are inside a project. A link that would make a **cycle between
projects** is refused, naming the path ("Mobile → Payments → Mobile").

### 7.3 Scheduling

- **Forward only, in v1.** An external predecessor becomes a **floor** on its successor, worked
  out from the predecessor's scheduled dates and the link type. It is added in
  `inheritedFloors` next to `not_before`. Inside a project nothing else changes, and
  `scheduleProject` stays a single-project function.
- **The cascade:** `replan(projectId)` returns, and then `replanDownstream(projectId)` replans
  every project reachable through `project_link`, in topological order, inside the **same
  transaction**.
  - It is bounded by the team's project count (a guard counter).
  - Each downstream replan is an ordinary `replan`, so auto bookings keep their ids and
    resolutions survive.
  - Every route that ends in `replan` today ends in `replanWithDownstream`. The CLAUDE.md
    rule "every write that can move a plan ends in replan" gains "…and its downstream
    projects".
- **Preview:** `planImpact` gains `downstream: { project, finishDelta, newClashes }[]`.
  `POST /api/tasks/preview` runs the cascade on a copy, so the banner can say "Moves Mobile
  release +4d and double-books UAT 12–14 Nov" before the save.
- **Portfolio critical path** is read-only. `portfolioSchedule` in `shared/plan.ts` runs
  `scheduleProject` over the merged network of the team's projects, with cross-project links
  as ordinary links, and marks the tasks that drive the latest project finish. It is never
  stored.

### 7.4 UI

- **After column:** typing `Payments:12` (a project name prefix, a colon, a task code) makes a
  cross-project link. Autocomplete suggests projects after the first letter and tasks after the
  colon. The cell shows it as a chip, `Payments·12`, with an outlined border so it reads as
  "from elsewhere". Clicking the chip opens that plan at that task.
- **Gantt:** an incoming external link is a short stub arrow entering the bar from the left,
  labelled `from Payments 12`. An outgoing one is a stub leaving to the right. Neither draws a
  line across the chart to a row that isn't there.
- **Portfolio:** links between projects are drawn with the existing `linkPath`. A new toggle,
  **Critical path across projects**, outlines the driving chain with `--critical-outline`
  (lines only, as now). The header comment "links between projects are not modelled yet" goes.
- **Impact banner:** downstream effects are listed under the project's own effects, one line
  per project, each naming the project and linking to it.
- **Deleting a task with outgoing external links:** the `DangerButton` cascade text names them
  ("Also removes 2 links to Mobile release").

---

## 8. Review a suggestion before applying it

### 8.1 What it does

Today a suggestion card has **Preview**, which shows the impact numbers inline, and **Apply**.
That is enough for one moved task. It isn't enough for a three-move plan that shifts dates,
switches an environment and changes who is busy when: a PM wants to *see* the plan as it would
be, check it from every angle, and only then commit.

Every suggestion from every source gets a **Review** button: the Safe, Balanced and Aggressive
profiles, tidy-ups, the LLM advisor's moves, and the new levelling moves (§5). Review opens a
**review page** that replaces the plan body. It shows the to-be plan against the current one
and has a fixed action bar with **Apply** and **Back to suggestions**.

Nothing is written until **Apply**. The review page is a reading of a plan that doesn't exist
yet.

### 8.2 Engine: one review, from the save's own functions

- **`reviewOps(projectId, ops, version)` in `server/assistant.ts`.** It extends `previewOps`.
  - It runs `applyChange` over a copy of the state, one op at a time, exactly as
    `previewOps` and `applyOps` do. It then builds both outcomes with `outcomeOf`.
  - It returns **two complete snapshots**, as-is and to-be, plus a diff:

    ```ts
    type PlanReview = {
      version: string;                 // refused on Apply if the plan has moved on
      status_date: ISODate;
      before: ReviewSnapshot;
      after: ReviewSnapshot;
      diff: ReviewDiff;                // shared/assistant/review.ts
      impact: PlanImpact;              // the existing banner numbers
    };
    type ReviewSnapshot = {
      tasks: Task[];                   // dated by planProject
      schedule: TaskSchedule[];
      bookings: Booking[];             // team-wide for the environments touched
      conflicts: Conflict[];           // conflictsFor, resolutions stamped
      workload: Overlap[];             // shared/workload.ts, incl. work elsewhere
      forecast: { p50: ISODate; p80: ISODate } | null;
      budget: EarnedValue | null;      // Phase C: shared/earnedValue.ts
      downstream: DownstreamEffect[];  // Phase E: the cascade, run on a copy
    };
    ```

- **`diffPlans(before, after)` in `shared/assistant/review.ts`** (new, pure). It lists:
  - each changed task: start, finish, duration, environment, people, `not_before` and links,
    with working-day deltas,
  - each changed booking: moved, stretched, created, removed,
  - double-bookings opened and cleared,
  - person overlaps opened and cleared,
  - deadlines newly met and newly missed (Phase A),
  - the change in finish, P80 and on-time chance.

  The page reads only this. It computes no span, clash or float of its own (CLAUDE.md "Risk
  numbers come from `shared/` only").
- **`POST /api/projects/:id/assistant/review { ops, version, date? }`** returns a `PlanReview`.
  - If the plan has changed since `version`, it returns 409, as apply does.
  - A review costs two `planProject` calls, plus the forecast twice when it is on. It counts
    against the per-request `planProject` cap, so the endpoint stays bounded.
- **Choosing some of the moves.** A multi-move suggestion can be reviewed with only some of its
  moves ticked. The page sends the chosen subset's ops to the same endpoint.
  - A subset is the user's own edit, not the engine's suggestion. It may open a
    double-booking that the full suggestion avoided.
  - The page says so plainly ("Without move 2, UAT is double-booked 2–4 Nov") and still
    allows Apply, exactly as a hand edit would.
- **Apply** calls the existing `POST …/assistant/apply` with the ops shown. It is the same
  transaction, the same `replan`, the same 6-second Undo. The review page only adds a way to
  look first.

### 8.3 UI: the review page

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│ ← Back to suggestions    Review: Balanced plan · 3 moves                          │
├──────────────────────────────────────────────────────────────────────────────────┤
│ Finishes Wed 25 Nov, 2 working days sooner.  On-time chance 62% → 81%.           │
│ Clears the UAT double-booking with Billing.  Mai is no longer on two tasks.      │
│ Nothing else moves: 3 tasks change, 23 stay as they are.                         │
├────────────────┬─────────────────────────────────────────────────────────────────┤
│ Moves          │ [Timeline] Environments  People  Budget  Other projects          │
│ ☑ Start T8 on  │ ┌─ Changed only ☑ ─────────── Show current as  ◉ Outline ○ Side ┐│
│   Mon 19 Oct   │ │ 8 Reconciliation   ┆┄┄┄┄┄┆      ████████  +5d                  ││
│ ☑ T12 to SIT-2 │ │ 12 Regression      ████████  SIT → SIT-2                       ││
│ ☑ Drop link    │ │ 15 Go-live                          ◆  −2d                     ││
│   9 → 14       │ └────────────────────────────────────────────────────────────────┘│
│                │                                                                   │
│ Changes (5)    │                                                                   │
│ T8  start +5d  │                                                                   │
│ T12 env        │                                                                   │
│ …              │                                                                   │
├────────────────┴─────────────────────────────────────────────────────────────────┤
│ Worked out on the plan as of 10:42. Nothing is saved yet.   [Back]  [Apply 3 moves] │
└──────────────────────────────────────────────────────────────────────────────────┘
```

- **Header:** the suggestion's title and profile. **Back to suggestions** returns to the plan
  with the drawer open on the same card. Esc does the same.
- **Verdict lines** come first, as on the Budget tab. They are templates filled from
  `diffPlans`, saying what gets better, what gets worse and what stays the same. Anything
  that gets worse is listed first and in bold, never hidden in a tooltip.
- **Left rail:**
  - **Moves**, each with a checkbox (multi-move suggestions only), its title and its reason.
  - **Changes**, every row the diff found, in plain words ("T8 starts 5 working days later").
    Clicking one scrolls the active view to it and highlights it.
- **Views** (a segmented control; the last one used is remembered per viewer):
  - **Timeline:** the to-be bars solid and the current position drawn as a dashed outline.
    Changed rows get a heavy ink rule at the left edge and a delta label (`+5d`,
    `SIT → SIT-2`). **Changed only** hides unchanged rows (on by default when more than 15
    rows). **Outlined** draws both on one chart; **Separate** draws a "Now" chart above an
    "After" chart on the same scale, scrolling together. As built, it's a read-only chart
    drawn with the `client/gantt.ts` scale, the way `Portfolio.tsx` draws, not `Gantt.tsx`:
    that component is an editor, and a review must not offer a drag that saves nothing.
  - **Environments:** the board's lanes, limited to the environments any booking in the diff
    touches, with as-is above to-be on one time scale. Double-bookings use the board's own
    hatch and the `--alarm` colour, because this is where they live. A cleared double-booking
    shows on the as-is side with a "cleared" label.
  - **People:** the workload strip (§5.3), as-is above to-be, limited to the people whose
    load changes. Overlaps opened or cleared are named in the rail.
  - **Budget** (Phase C): EAC, SPI and CPI before and after, and the S-curve's forecast
    line both ways. If the project has no costs, the tab isn't shown.
  - **Other projects** (Phase E): one row per downstream project, with its finish before and
    after and any double-booking the cascade would open, each linking to that plan.
  - A view whose content didn't change shows "No change to environments." and stays
    selectable, so "nothing changed" can be confirmed and not just assumed.
- **Action bar** (sticky at the bottom):
  - "Worked out on the plan as of 10:42. Nothing is saved yet." on the left.
  - **Back** and **Apply 3 moves** on the right. The button names the count of ticked moves.
  - On a 409 the bar changes to "The plan has changed since this was worked out." with
    **Find again**, and Apply is disabled.
  - After Apply: back to the plan, the existing `ImpactBanner` with Undo, and the drawer
    refreshed.
- **Keyboard and phone:**
  - Tab order runs header, verdicts, rail, views, action bar.
  - On a phone (≤ 820px) the page becomes one column that scrolls as a whole: header,
    verdicts, the rail, then the view. The action bar stays fixed at the bottom with the
    safe-area inset.
- **Inline Preview stays** on the card for a quick look. **Review** sits next to it as the
  primary button, and **Apply** remains on the card for people who don't need the page.

### 8.4 What deliberately doesn't change

- No new applier: Apply is `applyOps`. The review page can't disagree with the save, because
  both run `applyChange` → `outcomeOf`.
- No stored drafts. A review lives in the client's state for as long as the page is open. A
  "saved scenario" would be a new feature with its own plan-versioning questions; it's listed
  in §12.

---

## 9. Impact assessment

| Area | Deadlines | Baselines | Levelling | Earned value | Cross-project | Review page |
|---|---|---|---|---|---|---|
| Schema | 1 column | 1 table, 3 columns, migration | none | 4 columns | 1 table | none |
| Scheduler | backward pass seed | none | none | none | floors | none |
| `replan` | none | none | none | none | cascade | none |
| Assistant | rule P8, forecast hook | facts read compare baseline | move ML, rule H7, search term | none | facts gain downstream | `reviewOps`, `diffPlans`, 1 route |
| Files | CSV + MSPDI | MSPDI `<Baseline>` n | none | CSV + MSPDI | export only (no import) | none |
| Risk | low | low | medium | low | **high** | low (read-only) |

Cross-project links are the only feature that changes what `replan` writes outside the project
being edited. It goes last, behind its own tests (§10, Phase E).

---

## 10. Build plan (to-do)

Each phase ends with `npm test`, `npm run typecheck` and a check in the real UI (headless
Chrome, CLAUDE.md "Testing the UI"). Each phase is committed on its own and is useful by itself.

The review page goes first. It improves the assistant as it is today. Each later phase then
adds its own view to it, so every new kind of suggestion can be checked before it is applied.

### Phase R: review a suggestion before applying it (built 2026-10-04)

- [x] `shared/assistant/review.ts`: `diffPlans`, with tests:
  - an empty op list gives an empty diff,
  - a moved task reports working-day deltas, not calendar ones,
  - a cleared and an opened double-booking are both reported,
  - an auto booking that keeps its id shows as moved, not as removed and created.
- [x] `reviewOps` in `server/assistant.ts` and `POST …/assistant/review`.
  - 409 on a stale version.
  - Bounded by the per-request `planProject` cap.
  - A test that `review.after` has the dates planning the applied state gives. It runs
    over `buildReview` in shared/, since the tests don't open a database.
- [x] Review page (`client/components/Review.tsx`): header, verdict lines, the Moves and
      Changes rail, and the Timeline view through `Gantt.tsx`, with Outline / Side by side and
      Changed only.
- [x] Environments and People views.
- [x] Move checkboxes, with a re-review on change (debounced) and the plain warning when a
      subset opens a double-booking.
- [x] Action bar: Apply through the existing route, the 409 state with **Find again**, Back
      and Esc to the same card.
- [x] **Review** on every suggestion card: engine profiles, tidy, the advisor.
- [x] Headless Chrome check at desktop and phone width, light and dark.

Built as:
- `shared/assistant/review.ts`: `buildReview`, `diffPlans`, `verdictOf` and `workingShift`.
  `buildReview` runs the search's own `createSearch` → `tryOps` → `withForecast`, so both
  plans come from `ctx.apply`, the save's `applyChange`.
- `shared/workload.ts` gained `workItems`, `planOverlaps` and `loadByDay`. The plan's overlap
  mark now uses the first two, so the table and the review count overlaps one way.
- `reviewOps` in `server/assistant.ts`, and `POST /api/projects/:id/assistant/review
  { ops, version, date? }`.
- `client/components/Review.tsx`, opened by **Review** on every suggestion card (engine
  profiles, tidy-ups, the advisor).
  - Inline Preview and Apply stay on the card. Apply moved to a quiet button and Review is
    the primary one.
  - Back, and Escape, return to the drawer with that card's Review button focused.
  - Apply goes through the plan's own `applyOps`, then shows the usual banner with Undo.
- Tests: `tests/assistantReview.test.ts`.
- Checked in headless Chrome at 1440 and 400 px, light and dark, on the seed data. The review
  of the seed plan's aggressive suggestion leads with "Lan is on Vault regression in SIT (T3)
  and Merchant UAT (T6) at once for 3 working days". The suggestion card never said that.

### Phase A: deadlines (built 2026-10-04)

- [x] `task.deadline` column and migration. Add it to `TaskFields`, and to validation on the
      routes and in `applyChange`.
- [x] `inheritedDeadlines` and the backward-pass seed in `scheduleProject`;
      `deadline_slack` in `TaskSchedule`.
- [x] Tests:
  - a deadline before the CPM finish gives negative float,
  - a deadline on a summary reaches its leaves,
  - a deadline never moves a start,
  - the forecast zero-width test still passes.
- [x] Rule P8, and the forecast records the finish per sampled run for tasks with deadlines.
- [x] UI: the Deadline column, the Gantt chevron and overrun bracket, and the editor field with
      **Use current finish**.
- [x] Review page: deadlines newly met and missed in the diff, and the chevrons on the
      Timeline view.
- [x] CSV `Deadline`, and MSPDI `<Deadline>` both ways, with round-trip tests in
      `planIO.test.ts`.

Built as:
- `task.deadline`, migrated in `server/db.ts`. It is in `TaskFields`, `planVersion`, the audit
  log and the import route.
- `inheritedDeadlines` in `shared/wbs.ts`. The backward pass seeds a task's late finish with
  the end of the last working day on or before its deadline. `TaskSchedule` carries `deadline`
  and `deadline_slack`, and a summary rolls up its tightest task.
- The forecast keeps each deadline task's finish per run and reports `deadlines` (P80 and the
  chance of making it) without drawing extra random numbers, so existing forecasts don't change.
- Rule **P8**, keyed `P8:<task>:<days late>`.
  - Found in testing: a deadline downstream also took its predecessors' float negative, and P2
    then reported them as "fixed dates cannot all be met".
  - The fix: `planFacts` marks `deadline_driven` (negative with deadlines, not without; one extra
    schedule, run only when a deadline made float negative). P2 skips those tasks, so a missed
    deadline is reported once, as P8, naming the deadline.
- The table's Deadline column (off by default, in Show), with `Nd late` in words and weight.
- The editor field, with **Use current finish** and **Clear**. Its hint counts the working days
  with the shared `workingShift`.
- On the chart: an ink chevron, an ink bracket over the overrun, and `Nd late` in the label.
  None of it is a hatch or red.
- The review page lists deadlines newly missed (worse) or met (better) and draws the chevrons.
- CSV `Deadline` (also read as `Due`, `Due date` or `Finish by`) and MSPDI `<Deadline>`.
- The seed's Partner docs misses its deadline by two working days, so the warning shows on load.
- Tests: deadlines in `schedule.test.ts`, the forecast, P8 and P2 in `assistantRules.test.ts`,
  the review, and file round trips.
- Checked in headless Chrome: the column, the chart marks, the editor in light and dark, and P8 in
  the drawer.

### Phase B: named baselines (built 2026-10-04)

- [x] `baseline` table, `task_baseline.baseline_id`/`duration`/`cost`,
      `project.compare_baseline_id`, and the migration from the single baseline.
- [x] Baseline routes (§4.3), with the 10 cap and the "comparison baseline moves on delete"
      rule.
- [x] `shared/variance.ts`. Move the Gantt label's finish variance onto it.
- [x] Assistant facts read the comparison baseline.
- [x] UI: the Compare with picker and popover, the slip chart, Save current plan as…, and the
      variance columns.
- [x] MSPDI: write `<Baseline><Number>n</Number>` for each baseline (up to 10), and read them
      back as named baselines.

Built as:
- **Storage:** the `baseline` table, `task_baseline` keyed `(baseline_id, task_id)` with
  `duration` and `cost` (cost stays NULL until Phase C), and `project.compare_baseline_id`.
- **Migration** (`server/db.ts`): it rebuilds `task_baseline` in one transaction. Each project's
  old rows become a baseline named "Baseline", saved at `baseline_at`, and the one it compares
  with. Tested on a copy of a database holding an old baseline, and on a copy of the real one.
  `baseline_at` is no longer written.
- **Routes:**
  - `GET /api/projects/:id/baselines` (`?tasks=1` adds each one's rows, for files) and
    `POST /api/projects/:id/baselines { name }`.
  - `PATCH /api/baselines/:id { name?, compare? }` and `DELETE /api/baselines/:id`.
  - Names are unique per plan, ignoring case, and at most 80 characters. The 11th is refused,
    naming the oldest.
  - `planResponse` returns `baseline` (the compared one's rows, with length) and `baselines`.
- **`shared/variance.ts`:** `workingShift`, `varianceOf` and `formatShift`. The review page and
  the chart's `finishVariance` read it.
- **Assistant:** reads `compareBaseline`, so P6 and P7 follow the picker.
- **UI** (`client/components/Baselines.tsx`):
  - **Compare with** in the facts row shows the finish shift (bold when later).
  - Its popover holds the slip chart, the list (radio, Rename, Delete) and the form. On a phone
    the popover is a bottom sheet.
  - **Save baseline…** opens it with the name field focused.
  - Show → **Variance columns** adds Start var, Finish var and Days var.
- **MSPDI:** every baseline is written as `<Baseline><Number>n…`, and read back by number, never
  mistaken for the task's own dates. The import route merges them into "Baseline" and
  "Baseline n" while there is room.
- **Seed:** Card tokenisation R2 has two baselines that promised 22 and 27 Oct, so its slip
  chart climbs to the plan's 30 Oct.
- **Tests:** `tests/variance.test.ts` and the baseline round trips in `planIO.test.ts`.
- **Checked:** every route by hand on a scratch database (cap, clash, rename, compare,
  delete-compared, import), and the UI in headless Chrome at 1440 and 400 px, light and dark.

### Phase C: earned value (built 2026-10-04)

- [x] `resource.rate`, `task.fixed_cost`, `task.actual_cost`, `project.currency`. Cost routes
      as extras, the way `estimateFrom` works: they skip `replan`.
- [x] `shared/earnedValue.ts`, with tests:
  - a plan exactly on its baseline gives SPI = CPI = 1,
  - no baseline gives `missing`,
  - the weekly series is bounded,
  - summaries sum their leaves.
- [x] Budget tab: the verdict lines, the S-curve with end labels, the summary table with bullet
      bars, and both empty states.
- [x] The Cost column, the editor fields, and the Resources dialog's rate.
- [x] CSV and MSPDI cost fields.
- [x] Review page: the Budget view, with EAC, SPI and CPI before and after.

Built as:
- **Storage:** `task.fixed_cost`, `task.actual_cost`, `resource.rate` (per working day) and
  `project.currency` (default EUR), all migrated.
  - The task routes take costs as extras (`costFrom`, `setCost`). A cost-only edit skips
    `replan`, and summaries refuse a cost of their own.
  - The resource route takes `rate`, and the project route takes `currency`, a three-letter code.
- **`shared/earnedValue.ts`:** `plannedCost`, `costsOf`, `planCost`, `plannedShare`,
  `earnedValue`, `formatMoney` and `verdictOf`.
  - Percent complete moved to `shared/progress.ts` so earned value and the chart agree;
    `client/gantt.ts` re-exports it.
  - Tasks added after the baseline are left out and counted (`outside`). A baseline saved
    before costs existed is budgeted at today's cost (`from_plan`), and the tab says so.
  - Earned and spent are only known at the status date; there's no history of progress. The
    chart draws them as points joined to the start by a straight line, and says so in its
    description.
- **Server:** `server/money.ts` (`costInput`, `plannedCosts`, `projectEarnedValue`) and
  `GET /api/projects/:id/earned-value?date=`. Saving a baseline now keeps each task's planned
  cost.
- **UI:**
  - The **Budget** tab (`client/components/Budget.tsx`): status date, currency, verdict
    sentences, the S-curve with end labels and a forecast line from today's spend, SPI/CPI
    bullets, figures, the summary table, notes, and both empty states.
  - Show → **Cost columns** (Fixed cost, Planned, Actual).
  - Editor fields, and a **Day rate** in the Resources dialog.
  - The review page has a **Budget** view (plan cost before and after, and the tasks whose cost
    moves), plus a verdict line, only when something is costed.
- **Files:** CSV `Fixed cost` and `Actual cost`. MSPDI `<FixedCost>` and `<ActualCost>` in
  hundredths, both ways, with summaries' rolled-up costs ignored on import. Day rates are
  written as hourly `<StandardRate>`, export only.
- **Seed:** day rates for Mai, Tuan, Lan and Linh. The HSM stub has a €4,000 licence and the
  vault a typed €2,600 actual. On load, Card tokenisation R2 reads 51% behind and 15% over,
  heading for €23,466 against €19,960.
- **Tests:** `tests/earnedValue.test.ts` (11), the review's cost line, and money in CSV and MSPDI.
- **Checked:** headless Chrome at 1440 and 400 px, light and dark, the empty state, and a
  currency change.

### Phase D: levelling people (built 2026-10-04)

- [x] `PlanFacts.overlaps` from `shared/workload.ts`, including work elsewhere.
- [x] Rule H7, and the person filter's mark reads from it.
- [x] Move ML, plus the overlap-days term in the search order.
- [x] Extend `tests/assistantOptimise.test.ts`: on random plans with people, a kept plan never
      has a new open double-booking, P80 never gets later in the balanced profile, and ML
      within float never moves the finish.
- [x] UI: the People workload strip, the drawer's filter row, and **Level people**. Levelling
      suggestions open the review page on its People view.

Built as:
- **Facts:** `PlanFacts.overlaps` (each with both tasks' spans, here or in another plan) and
  `overlap_days`, from `workItems` and `planOverlaps`. The server passes `elsewhere` to the facts
  and the search.
- **Search:** `Evaluation.overlapDays`, ranked right after new double-bookings.
  - **ML** is in every profile, since it is as safe as M1. **MLX** is aggressive only.
  - The headline says "frees N days of people on two tasks at once".
  - `suggest(…, { only: 'people' })` is `GET …/assistant/suggestions?focus=people`.
- **Rule H7**, keyed `H7:<person>:<task>:<task>`, skips pairs S5 already covers. The rubric
  legend now lists P8 and H7.
- **As built, the table's overlap mark still uses `planOverlaps` directly**, rather than reading
  H7 from the report. It's the same rule, and this way the mark doesn't wait on the assistant's
  report.
- **UI:**
  - Show → People: the People strip, with labels.
  - The drawer's filter row with counts, and **Level people**.
  - A review of a levelling suggestion opens on People.
- **Seed:** Refund API v3's Partner sandbox puts Tuan on two tasks at once. Level people
  finds the safe ML move, and the finish holds.
- **Tests:** `tests/assistantPeople.test.ts`: facts here and elsewhere, H7 and S5, ML in the
  safe profile, MLX only in the aggressive one, and a random-plan property (no new
  double-booking, fewer overlap days, ML never moves the finish).
- **Checked:** in headless Chrome.

### Phase E: links between projects

- [ ] `project_link` table, and routes to create, change and delete links, with the
      project-cycle refusal naming the path.
- [ ] External floors in `inheritedFloors`, and `replanDownstream` in the same transaction.
      Every replanning route moves to `replanWithDownstream`.
- [ ] `planImpact.downstream`, and the preview runs the cascade on a copy.
- [ ] Tests:
  - an upstream slip moves the downstream plan,
  - downstream auto bookings keep their ids, and an accepted double-booking stays accepted,
  - a project cycle is refused,
  - the cascade is bounded,
  - editing either project leaves its `project_link` rows untouched.
- [ ] `portfolioSchedule`, the Portfolio arrows, and the critical-path toggle.
- [ ] UI: `Project:code` in After with autocomplete, external chips, Gantt stubs, downstream
      lines in the impact banner, and the cascade text on delete.
- [ ] Review page: the Other projects view, fed by the cascade run on a copy.

### After each phase

- [ ] Add that phase's rules to CLAUDE.md (§11).
- [ ] Update `docs/gantt/user-guide.md` and the DESIGN.md §12 list.

---

## 11. Rules to add to `CLAUDE.md` once built

- **A deadline changes float, never dates.** It seeds the late finish in the backward pass;
  `forwardPass` never reads it.
- **The comparison baseline is the only one anything reads.** The others exist for the slip
  chart and for switching. Variance comes from `shared/variance.ts` only.
- **Cost is not plan state.** Like people and estimates: not in `TaskFields`, and an edit
  touching only cost skips `replan`. Earned value is computed in `shared/earnedValue.ts` only,
  against the comparison baseline's snapshot, at a status date passed in.
- **Levelling is a suggestion.** ML is a move like any other; nothing levels on save.
- **The review page reads `PlanReview`, never rows.** `reviewOps` runs `applyChange` →
  `outcomeOf` exactly as `applyOps` does, and Apply calls `applyOps`. Never give the review
  page its own way of computing the to-be plan: it would show a plan the save doesn't make.
  `diffPlans` is the only place a difference between two plans is worked out.
- **Cross-project links live in `project_link`, never `task_dependency`**, because `writeState`
  rewrites the latter on every edit. Every write that replans ends in `replanWithDownstream`,
  in one transaction.

## 12. Decisions needed

Answered 2026-10-04: the proposed answer for each of 1–8.

1. **Deadline on a summary:** inherit to leaves (proposed), or apply to the roll-up only?
2. **Baseline cap:** 10 (proposed; MS Project allows 11), or unlimited?
3. **Currency:** one per project (proposed), or one for the whole app?
4. **Actual cost when not entered:** estimate from time and rates (proposed, marked
   "estimated"), or show no AC until someone types it?
5. **Cross-project links across teams:** same team only in v1 (proposed), since the portfolio
   is per team.
6. **Cross-project backward pass:** v1 is forward only, so an upstream task doesn't lose float
   because of a downstream deadline. Is that acceptable until the portfolio critical path
   proves useful?
7. **Review page as the default:** should **Review** replace inline Preview on the card, or
   sit beside it (proposed)?
8. **Saved scenarios:** keep a reviewed suggestion as a named "what if" to come back to later?
   Not in this plan (§8.4). It needs its own answer to what happens when the plan changes
   underneath it.
