# Design — simple timeline

Solution and UI design for the MVP. Derived from `reqs.md` §10 answers.

## 1. Decisions locked from your answers

| # | Answer | Consequence for the build |
|---|---|---|
| 1 | No auth | No users table, no sessions. `audit_log.actor` kept but fixed to `"local"`. Cuts ~⅓ of scope. |
| 2 | One env set per team, shared by that team's projects | Environments are team-scoped. `capacity` stays, defaults to `1`. Conflict detection partitions by team — never a cross-team query. |
| 3 | No cross-team sharing | `environment.shared` flag dropped from MVP schema. |
| 4 | No import | Editing UI is the only way data arrives, so it must be fast. Inline editing prioritized over forms. |
| 5 | One nesting level | `project.parent_id` nullable, depth capped at 1 and enforced in the API. |
| 6 | Skip weekends/holidays | See §1.1 — this splits in two. |

### 1.1 Working days: effort vs. occupancy

These are different and conflating them produces wrong conflict results.

- **Effort = working days.** Durations, the "10 working days" label, drag/resize snapping, and
  bulk shift all skip weekends and holidays. A booking can't start or end on a non-working day.
- **Occupancy = calendar days.** A booking Fri→Mon holds the environment through the weekend.
  Overlap detection therefore runs on the raw calendar interval.

Weekends and holidays are shaded in the grid, so the rule is visible rather than a hidden surprise.
A `holiday(date, name)` table seeds the calendar; empty is fine, weekends still apply.

## 2. Architecture

```
React + TS (Vite)                Express + node:sqlite               SQLite
┌──────────────────┐   fetch     ┌──────────────────────┐            ┌────────┐
│  Board renderer  │ ──────────► │  /api/*              │ ─────────► │ .db    │
│  Conflict panel  │ ◄────────── │  conflict engine     │ ◄───────── │ file   │
└──────────────────┘   JSON      └──────────────────────┘            └────────┘
         │                                  │
         └──── shared/conflicts.ts ─────────┘   one pure module, both sides
```

**Stack**: Vite + React 18 + TypeScript; Express over `node:sqlite`; plain CSS with custom
properties. No component library and no Tailwind — the board is computed positioning, and a
component kit would fight the bespoke layout rather than help it.

The plan said `better-sqlite3`, but the machine runs Node 25, which ships SQLite in core and
strips TypeScript natively. Both dependencies went away: no native build, and no compile step
for the server. `DatabaseSync` is synchronous, which suits a single-user local tool — no
connection pool, no async ceremony.

**Why a server at all** given single-user/no-auth: durable data outside the browser profile, and
the read-only share link in V2 needs an origin to serve from.

**Dates**: date-only ISO strings (`YYYY-MM-DD`) at every boundary. No `Date` objects cross the API.
This kills the timezone off-by-one from `reqs.md` §5 at the type level rather than by convention.

**Rendering**: absolutely-positioned DOM bars — deliberately *not* canvas. Canvas would render
3,000 bars more cheaply but destroys keyboard focus and screen-reader access, which §5 requires.
Bars are clipped to the visible date window by the server's `from`/`to`. Row virtualization was
specced but not built: rows are bounded by the mandatory team filter (≤10 environments, ≤30
projects), so there is nothing yet to virtualize. Revisit if the team filter ever becomes optional.

**Conflict engine**: sweep line per environment over committed bookings sorted by start date;
maintain an active set; emit a conflict interval whenever `|active| > capacity`. O(n log n).
Lives in `shared/` so the server computes it and, in V2, drag previews recompute it client-side
from the identical code.

## 3. Data model (MVP)

```sql
team(id, name, code, active, created_at)
environment(id, team_id, name, kind, capacity DEFAULT 1, sort_order)
project(id, team_id, parent_id, name, status, priority, owner, description, external_link,
        start_date, target_date)
booking(id, project_id, environment_id, kind, start_date, end_date, confidence, optional, note, marker,
        timeline_text, manual_start, manual_end, hold_start, hold_end, hold_done)
task(id, project_id, environment_id NULL, name, duration, status, not_before, note,
     sort_order, actual_start, actual_end, start_date, end_date, total_float, critical)
resource(id, name, name_key UNIQUE, active)        -- people, global; reqs/resources.md
task_resource(task_id, resource_id, sort_order)    -- who does a task, in the order typed
task_dependency(predecessor_id, successor_id, lag)
holiday(date PRIMARY KEY, name)
audit_log(id, entity, entity_id, field, old_value, new_value, actor, at)

CREATE INDEX idx_booking_env_range ON booking(environment_id, start_date, end_date);
```

`phase` is renamed **`booking`** throughout, code and UI alike. The thing a project does to an
environment is reserve it, and naming it so makes the whole feature explain itself.

Any booking may carry a free-text `note`, shown in the bar's tooltip and edited in the booking
dialog. A `CUSTOM` booking may also carry a `marker` (`star`, `flag` or `pin`), drawn at the
start of its bar, or in place of the diamond when it is a single day. The marker takes the
environment hue, like the diamond, so `--alarm` stays the only red. The API clears `marker` for
any other kind. Databases created before these columns are backfilled by `server/db.ts`.

Dropped from the sketch for MVP: `conflict_ack` (V2), `environment.shared` (answer 3),
`project.tags` (no use yet).

## 4. API

```
GET    /api/bootstrap                     teams + environments + holidays, one call on load
GET    /api/board?team=&envs=&from=&to=   render-ready rows and bars
GET    /api/conflicts?team=&from=&to=     detected double-bookings
POST   /api/teams                         creates team + seeds SIT, UAT, PROD
PATCH  /api/teams/:id                     DELETE /api/teams/:id
POST   /api/environments                  PATCH /api/environments/:id   DELETE /api/environments/:id
POST   /api/projects                      PATCH /api/projects/:id       DELETE /api/projects/:id
POST   /api/bookings                      PATCH /api/bookings/:id       DELETE /api/bookings/:id
POST   /api/bookings/:id/release          trim a finished booking to its last task
GET    /api/projects/:id/plan             tasks, links, schedule, holds, this project's bookings
POST   /api/tasks                         PATCH /api/tasks/:id          DELETE /api/tasks/:id?bridge=1
POST   /api/tasks/reorder                 POST  /api/tasks/preview      (dry run: what a change would do)
```

Dependencies are written through a task's `predecessors` (the whole set, replaced), not a
separate endpoint: the table edits them as one cell, and one write keeps one replan.

`/api/board` returns rows already grouped and bars already positioned in date space, so the
client never joins entities during interaction.

---

# UI design

## 5. Grounding

This is not a generic project dashboard. The thing being modeled is **a resource booking board** —
the vernacular of hotel room charts, studio schedules, and operating-theatre rosters. A project
*books* an environment; two projects wanting SIT at once is a *double-booking*. That metaphor
drives every visual decision below, and it drives the copy: the UI says "books" and
"double-booking", never "phase" or "conflict entity".

**Audience**: a technical lead scanning for trouble, not a stakeholder being impressed.
**Primary job**: make a double-booking impossible to miss, and everything else quiet.

## 6. Tokens

### Color

The board is a ruled instrument on drafting paper. The only saturated, alarming color in the
entire interface is a double-booking — that is where all the boldness is spent.

| Token | Hex | Role |
|---|---|---|
| `--paper` | `#EDF1F4` | app ground, cool drafting paper |
| `--lane` | `#FFFFFF` | row surface |
| `--ink` | `#16202B` | primary text, heavy rules |
| `--rule` | `#C7D1DA` | hairlines, grid |
| `--muted` | `#59677A` | secondary text, ruler labels |
| `--alarm` | `#D3232F` | double-bookings only — used nowhere else |

Environment kinds carry their own hue, deliberately avoiding the red family so `--alarm` stays
unique on screen:

`SIT #2E8C8C` · `UAT #3A62C4` · `NFT #B5731A` · `PENTEST #7A4BAE` · `PROD #1F7A45`

Dark theme swaps `--paper`/`--lane` to `#151B21`/`#1D252D` and lifts the kind hues ~12% lightness;
`--alarm` becomes `#FF5A63` to hold contrast on dark. Every token is defined on bare `:root` first.

### Type

**Archivo** and **Archivo Narrow** — one family, two widths. A grotesque built for dense
functional settings, with real tabular figures. The width contrast does work rather than
decorate: Narrow handles the date ruler and lane labels where horizontal space is scarce,
regular handles everything else.

All figures set with `font-feature-settings: "tnum" 1` so dates and day counts align in columns.
Explicitly no monospace face for data labels — a grotesque with tabular figures reads better on a
board and mono-for-small-labels is a tell.

```
Board title      Archivo 600, 19px, -0.01em
Lane label       Archivo 500, 13px
Project name     Archivo 500, 14px
Date ruler       Archivo Narrow 500, 12px, --muted
Bar label        Archivo Narrow 600, 11px
Day counts       Archivo 400, 12px, tnum
```

Sentence case everywhere. No tracked-out caps eyebrows.

## 7. Layout

Two modes over one renderer. Mode is the primary control, top-left of the board.

**By environment** (default — the conflict view). Rows are environments; every project competing
for that environment stacks into sub-lanes inside the row. Overlaps are literally stacked on top
of each other, which is the whole point.

**By project** (the planning view). Rows are projects; bars are that project's bookings.

```
┌───────────────────────────────────────────────────────────────────────────┐
│  simple timeline     Platform ▾            Week  ⟨Month⟩  Quarter          │
├───────────────────────────────────────────────────────────────────────────┤
│  TODAY   SIT  Payments R2, ends in 4d     UAT  free     PROD  Core 4.1     │ ← occupancy strip
│          next  Billing, Mar 3             next  Payments R2, Mar 10        │
├──────────────┬────────────────────────────────────────────────────────────┤
│ By environment│  February      March          April           May          │ ← ruler, sticky
│ By project    │ ░░  ░░  ░░  ░░│░░  ░░  ░░  ░░ │░░  ░░  ░░  ░░ │           │ ← weekend shading
├──────────────┼────────────────────────────────────────────────────────────┤
│ SIT       2/1 │   ▬▬▬▬ Payments R2 ▬▬▬▬                                    │
│               │              ▬▬▬▬▬ Billing ▬▬▬▬▬                           │
│               │              ╳╳╳╳╳  ← double-booked, 5 days                │
├──────────────┼────────────────────────────────────────────────────────────┤
│ UAT       0/1 │                    ▬▬▬▬▬▬▬ Payments R2 ▬▬▬▬               │
├──────────────┼────────────────────────────────────────────────────────────┤
│ PROD      1/1 │                              ◆ Core 4.1                    │
└──────────────┴────────────────────────────────────────────────────────────┘
   ▲ lane label carries live occupancy: booked / capacity
```

Left rail is sticky and left-aligned; the time grid scrolls horizontally. Day counts and dates
are right-aligned on their tabular figures. Release dates render as diamonds (`◆`), not bars,
since they are moments rather than spans.

**Structure that encodes information, not decoration:**
- Weekend and holiday columns are shaded — the working-days rule made visible.
- Lane label shows `booked/capacity` live, so an over-capacity lane announces itself in text
  before you even look at the bars.
- A lane over capacity gets a heavy `--alarm` rule down its left edge for exactly the
  conflicting date span — the rule weight itself is the signal.
- No numbered markers anywhere; the content is a timeline, and the date ruler already sequences it.

## 8. How a double-booking looks

Three redundant signals, never color alone (§5 accessibility):

1. **In the lane** — the overlapping span fills with a `--alarm` diagonal hatch across the
   stacked bars, plus a `╳` glyph at its center and the day count ("5 days").
2. **In the rail** — the lane's occupancy reads `2/1` in `--alarm`.
3. **In the panel** — a right-hand drawer lists every double-booking, sorted by severity
   (overlap days × highest priority involved), each naming the environment, the date span, and
   both projects. Clicking one scrolls the board to it.

A toolbar count sits next to the mode switch: "3 double-bookings". At zero it reads
"No double-bookings" in `--muted` — a calm board is the success state and should look like one.

## 9. Motion

One orchestrated moment: on first paint, bars draw in left-to-right in date order over ~400ms, so
the eye reads the board as time. Conflict hatching fades in once, 200ms after the bars settle, so
it arrives as a verdict on a board you've already seen. Nothing else animates unless you act on it.
Opening the drawer and confirming an edit get motion because they show what changed.
All of it behind `prefers-reduced-motion`.

## 10. Copy

Plain, active, consistent. The button that says "Book environment" produces a toast that says
"Booked".

- Empty board: "No projects yet. Add one to start booking environments." + **Add project**
- Empty conflict panel: "No double-bookings in this range."
- Validation: "SIT is booked by Billing until Mar 14." — states the fact and names who, rather
  than apologizing or saying "invalid date range".
- Non-working day: "Bookings start and end on working days. Nearest is Mon, Mar 3."

## 11. Design review against the brief

Four things in my first pass were defaults rather than choices, and I changed them:

1. **A KPI tile row** ("3 conflicts" as a big number) → replaced with the **occupancy strip**.
   The count is a vanity metric; "who holds SIT today, and who's next" is the question the QA
   and lead personas actually open the tool with, and it's the characteristic moment of a
   booking board.
2. **Team-as-bar-color**, carried over from `reqs.md` §4.1 → removed. With both environment kind
   and team driving hue, the board becomes a rainbow and the red stops being the loudest thing.
   Environment kind owns color; team is expressed through grouping and a small ink code chip.
   This is the one accessory removed.
3. **Monospace for dates and counts** → Archivo with tabular figures. Better on a dense board,
   and mono-for-small-data-labels is a generated-page tell.
4. **Cream ground, serif display, warm clay accent** → cool drafting paper, one grotesque in two
   widths, signal red reserved for alarm. The warm-paper-and-serif look belongs to editorial
   work, not an instrument you scan for trouble.

## 12. MVP build order

1. Scaffold, SQLite schema, migrations, seed demo data (3 teams, ~12 projects, deliberate overlaps)
2. `shared/dates.ts` (working days, holidays) + `shared/conflicts.ts` (sweep line) + unit tests
3. API routes
4. Board renderer: ruler, weekend shading, today line, bars, both grouping modes, zoom
5. Conflict hatching, occupancy strip, conflict drawer
6. Editing: teams, environments, projects, bookings
7. Responsive pass, keyboard nav, reduced motion, dark theme

**In MVP**: swimlane/environment mode, promoted from V2 per §1 above.
**Built since**: full CRUD (§13), drag-to-edit (§14), conflict resolution, task management (§16).
**Still open**: sub-project roll-ups, saved views, bulk shift. For tasks: cross-project links
(the portfolio shows plans side by side, but a replan does not cascade between them), resource
levelling, start-to-finish links, more than one baseline, and a virtualised chart for plans of
several hundred rows.

## 13. Built beyond the original MVP list

Full CRUD on every entity, added after the first pass exposed three gaps: teams had no edit
or delete UI at all, projects could not be edited or removed once created, and a project with
no bookings was invisible on the board and therefore unreachable.

- Three manager dialogs of one shape — list, inline edit, add row — for teams, projects and
  environments. Bookings keep their own dialog, since they carry date logic.
- Rail row labels open the editor for the row they name.
- `DangerButton`: destructive actions arm on first click and state their cascade from
  server-supplied counts, then disarm after 4s. Chosen over `confirm()` (blocks the page) and
  over a stacked dialog (loses the context you are deleting from).
- Unarmed delete buttons are deliberately **not** red. `--alarm` means double-booking; a row
  of red Remove buttons would dilute it. The colour arrives with the armed state, at the
  moment the danger is real — an extension of the §6 rule, not an exception to it.

## 14. Drag-to-edit

The reason `shared/conflicts.ts` was put in `shared/` in the first place: the drag preview
and the server now run the identical sweep line, so what the board predicts under the
pointer is what the save produces.

**Date math** lives in `client/dragMath.ts`, pure and tested apart from the pointer code.
Moving preserves the **working-day** length rather than the calendar length — dragging a
five-working-day booking across a weekend must not quietly make it seven. Resizing moves
one edge and clamps rather than inverting. Every result lands on working days at both
ends, which makes the server's own snap a no-op, so nothing jumps on drop.

**Click versus drag** is decided in `useBookingDrag`, not by a click handler racing the
gesture: a release within 4px opens the booking, anything further commits. Keyboard
activation bypasses that entirely — the bar's `onClick` fires only when `event.detail === 0`,
which only a keyboard produces.

**Optimistic preview.** `pendingSpans` in `App` holds provisional dates by booking id. The
board, the conflict engine and the drawer all read through it, so a collision appears while
you are still holding the bar. It survives until the refresh lands, so the bar never snaps
back for a frame, and is dropped on failure to restore the saved dates.

**Keyboard parity.** Arrows move, shift/alt take an edge. Presses are debounced into a single
write. Without this, drag-only editing would have made the board's own accessibility
requirement (§5) a dead letter.

**The readout** states the outcome rather than decorating the gesture: new dates,
working-day length, and a red `double-booked` badge when the drop would clash.

## 15. Phone layout

At 640px and below the board keeps the real timeline rather than turning into a list: two
projects stacked in one lane is how a double-booking reads, and a list would lose it. Every
change serves one goal, giving the timeline the full width and most of the height.

```
┌──────────────────────────────┐
│ ■ Payments Platform ▾  W|M|Q │  team is the title; opens team, filter, managers
│   By environment | By project│
├──────────────────────────────┤
│  14 Sep   21 Sep   28 Sep    │  ruler, sticky
┃ SIT 2/1 Card tok. until 1 Oct│  lane header, sticky to the left edge
┃ ▬▬▬▬Card tokenisation▬▬▬     │
┃       ▬▬▬Settlement▬▬▬▬▬     │
│ UAT 0/1 Free, next …         │
├──────────────────────────────┤
│ ◆ 3 double-bookings  ⌃ │ Book│  bottom bar, in thumb reach
└──────────────────────────────┘
```

- **Lane headers replace the rail.** Each lane names itself in a band whose label is
  `position: sticky; left: 0`, so it stays readable however far the board scrolls. The band
  carries the occupancy (`booked/capacity`) and who holds the environment today or next, which
  is the occupancy strip's job, so the strip is not shown. A conflicted lane keeps the rail's
  red left rule on its header.
- **The double-booking count owns the bottom bar** and opens the list as a sheet that rises
  from it. Picking one scrolls the board to it in both directions with a single `scrollTo`
  (two smooth scrolls cancel each other) and flashes the lane.
- **Team, environment filter and the three managers** fold into one sheet behind the title.
- **Editors are full screen**, with inputs at 16px so iOS does not zoom on focus.

### Touch

A finger on a bar is usually the start of a swipe, so bars use `touch-action: pan-x pan-y`
and the board scrolls freely over them. `classifyTouch` in `client/touch.ts` decides: movement
past 8px is a scroll, a still 400ms press picks the bar up (a short vibration confirms it),
and a quick still release is a tap. Once picked up, the bar takes `touch-action: none`, a
non-passive `touchmove` stops the board scrolling under it, and 24px resize tabs appear just
outside both ends. It stays picked up until something else is touched.

A tap opens a **booking sheet**, not the full editor. It is non-modal, so the board stays live
above it. Its −1/+1 day steppers call the same `nudge` as the arrow keys, which means the
conflict preview follows each tap and a run of taps saves once. The drag readout is pinned
to the top of the board on touch, since under a finger it would be hidden by the finger.

**Pinch steps the zoom** one grain per gesture (`pinchStep`), anchored on the date under the
pinch. It never scales continuously: the ruler only runs at its three tested scales (see the
bounded-loop rule in `CLAUDE.md`).

The board opens on today once per team and zoom, not on every data change. It used to
re-scroll after every refresh, which made each save throw the view back to today.

## 16. Task management

From `reqs/simple_task_management.md`. A project gets tasks with durations and links; a task on
an environment books it. The board's job does not change: tasks are one more way bookings are
made, and double-bookings are still found by the same sweep over the same rows.

### 16.1 Decisions

| Question | Decision |
|---|---|
| A manual booking outlasts its tasks, which are all done | The booking stands. The board fades its tail and offers **Release**, which trims it to the last task |
| How task dates are set | Scheduled (critical path method), never typed: duration, links, and an optional "start no earlier than" |
| Two tasks on one environment with a gap | One hold while the gap is at most 2 working days (`HOLD_GAP_DAYS`); a longer gap frees the environment |
| Links across projects | Same project only |

### 16.2 How tasks become bookings

```
tasks ──scheduleProject──► dated tasks ──taskHolds──► holds ──reconcileBookings──► bookings
        shared/schedule.ts               shared/taskHolds.ts                        (ordinary rows)
```

- **Schedule.** Forward and backward passes over working-day indexes from the project start.
  Finish-to-start with a lag (negative is a lead). Done tasks sit on their actual dates, started
  ones keep their actual start. Critical means total float ≤ 0 on work not yet done. A milestone
  (0 days) sits on its predecessor's last day.
- **Holds** are calendar spans, like every booking, so conflict detection needs nothing new.
  Milestones and tasks without an environment hold nothing.
- **The longer wins.** A booking keeps its manual span (`manual_start`/`manual_end`) beside the
  effective one (`start_date`/`end_date`). A hold that overlaps a manual booking stretches it
  to the hull, never below what was booked; a hold that overlaps none becomes an **auto
  booking** (manual dates NULL) that follows its tasks. A hold attaches to the one manual
  booking it overlaps most.
- **Identity.** Auto bookings are matched to their previous row by overlap, then nearest start,
  so an accepted double-booking keyed on one stays accepted as its tasks move.
- **One write path.** Every task, link, project-start, booking and holiday write ends in
  `replan` (`server/plan.ts`) inside the same transaction. A loop is refused by name and rolls
  the change back.

Editing a booking by hand sets its manual span. The dialog shows the manual dates, not the
stretched ones, and sends dates only when they changed, so a note edit neither locks a stretch
in nor turns an auto booking manual. A drag books what you see: its span becomes the manual
one, and the preview runs it through `spanWithHold`, the same rule the server applies, so a
bar cannot be dragged below its tasks and nothing jumps on drop. An auto booking cannot be
deleted; the error names the tasks that would book it straight back.

### 16.3 Impact before and after

`POST /api/tasks/preview` runs the same pure plan over the change without writing, and
`planImpact` compares the two: tasks moved, successors unlinked, finish and target, critical
path, bookings created, removed, stretched or shrunk, and double-bookings added or cleared
(compared by project pairs, so joining a clash is one new fact). Risk is **high** when it makes
an open double-booking, pushes the finish further past target, or deletes a critical task with
successors.

The task editor shows "Saving would…" live and "Deleting it would…" before Delete is armed,
with **keep the chain** (link its predecessors to its successors) on by default. An inline
edit in the table saves at once and then says what it did, in a banner with Undo.

### 16.4 UI

**Grounding.** A scheduling instrument, not a to-do app: the question is which work holds
which environment and what drives the dates. So there is a table to enter work fast and a
network to see why, and no kanban.

**Colour.** No new hues. The critical path is heavy ink (`--critical`), except its lines: a
critical bar's outline on the Gantt chart and in the portfolio, and a critical arrow on the chart,
in the network and in the portfolio, are red (`--critical-outline`, by request; lines only, never a fill). Otherwise `--alarm` appears
only on a change that would double-book. Environment hue is a stripe on a task's environment cell,
node or lane. Status is a glyph and a word (○ ◐ ‖ ●). Late is weight and words ("5 working days
late"). A task-made booking has a dashed edge; a releasable tail is a wash of the lane with a
dashed ink edge where the work ended.

**Plan workspace** (`#plan/<id>`, from the rail's Plan button in project mode, or the projects
manager) replaces the board. Its header holds the project switcher, the start and target dates,
the computed finish and the critical-path count. **Books** along the foot lists the bookings the
plan makes or stretches, and a Release button where one is due. A plan link names a project,
so it switches the board to that project's team.

**Task table.** Edited in place. Each task has an ID (`task.code`), a whole number unique in
its project: typed, or offered as the task count plus one (the next free number if that is
taken). After takes IDs with a lag (`2`, `2+3`, `3-1`), and offers matching tasks as you type a
number or part of a name. IDs are not row numbers, so moving a row never rewrites a link; links
are stored by task id either way. Drag a row number to move the row (and the tasks under it)
above another; it joins that row's level, and a click still opens the task. Enter
moves on, and Enter in the add row keeps the caret there for the next task. Start and Finish
can be typed over, but dates stay scheduled: a typed start becomes "start no earlier than" (or
the actual start once work has begun) and keeps the length; a typed finish sets Days to the
working days from the start, weekends and holidays left out (a finished task records it as
its actual finish). When the schedule cannot land on the typed date, a note says why: not a
working day, or a predecessor finishes later. Alt+↑/↓ reorders.
Critical rows carry a heavy ink rule. A task that should have started carries a warning mark in
ink beside its status (never red; the alarm is spent), which names the date on hover, focus or
tap. On a phone, rows become stacked cards.

**Gantt beside the table** (`client/components/Gantt.tsx`, pure helpers in `client/gantt.ts`).
The table and the chart each scroll sideways on their own, and up and down together (rows and
bars must stay level), each with its header stuck in place. A divider between them drags (or
takes ←/→, Shift for bigger steps); narrowing leaves the right-hand columns a sideways scroll
away in the table, widening gives the room to the task name, and a double-click or End restores the whole table. The chart does not
lay out rows: the table measures its own rows and the chart draws at those heights, so a taller
row never drifts, and a row the table hides is not drawn.

*Scale.* Columns are weekdays only: task spans are working days, so a Friday bar meets the
Monday bar after it. Holidays keep their column, shaded. Three zoom steps, never continuous:
**Days** (22px a day; week over weekday), **Weeks** (8px; month over week), **Months** (3px;
quarter over month). Changing step keeps the same day at the left edge. **Fit** picks the widest
step that shows the whole plan; **Today** scrolls to this week, which is also where it opens.

*Marks.* Bars carry the environment hue; a task on no environment is hollow; a critical bar or
milestone has a red outline (`--critical-outline`, by request: an outline only, never a fill,
so it does not read as a clash) and critical links are red lines too; done is faded; a milestone is a diamond; a summary is an ink bracket.
Progress is an ink band along the foot of the bar. **Float** is a thin tail to the last day the
task may finish. **Baseline** is a grey rule under each bar, with the finish variance in working
days after the label (`+3d`). **Bookings** washes each task's row with the booking it belongs to,
dashed when tasks made it, and a releasable tail is a lane wash with a dashed ink edge that
releases on click. Other links are ink, never orange: warm hues sit too near the alarm. The target is
a dashed ink line; today is the board's thin red line and flag. Pointing at or focusing a task
keeps its chain (everything it waits on and everything waiting on it) and fades the rest.
Labels, float, baseline, bookings and the strip are switched under **Show** and remembered.

*Environments strip.* Under the chart, one lane per environment the plan uses, across the whole
team: how full it is in quiet ink, and each double-booking over it, red when open, green when
accepted. It comes from `/api/board` and the shared conflict engine, never a count of its own.

*Editing on the chart.* Drag a bar to move it, its right end to change its length, or the dot
after it onto another task to link them; click a link to change its type or lag, or remove it.
Alt+←/→ on a focused bar moves it and Alt+Shift+←/→ resizes it, settling into one write. A drop
lands on working days (`draggedStart`, `draggedFinish`) and becomes exactly the fields a typed
date does (`startFields`, `finishFields`), saved through the same setStart / setFinish, so the
impact banner, notes and Undo are the same. While dragging, the plan is re-run in the browser
with `planProject`, `bookingsFor` and `conflictsFor` from `shared/plan.ts`: successors move, the
strip redraws, and a double-booking the drop would make is named in red beside the bar before
anything is saved. Summaries are opened, not dragged. On a phone the chart and its controls are
hidden.

**Outline.** A task can sit under another (`task.parent_id`), which makes that one a summary
(`shared/wbs.ts`). The outline is always read depth-first, `sort_order` ordering siblings only,
so a summary's tasks follow it by construction. Alt+Shift+→ puts a task under the one above it,
Alt+Shift+← takes it out a level, Alt+↑/↓ swaps it (with everything under it) with a sibling;
the task editor's **Part of** does the same. A summary is not scheduled: its dates, float and
criticality roll up from its tasks, it books nothing (its environment is cleared), and its own
length stops counting. A link to a summary holds every task under it and a link from one waits
for all of them (`expandLinks`); such links are finish-to-start only, and a link between a task
and its own summary is refused, or dropped when an outline move creates it. Deleting a summary
lifts its tasks a level, or takes them with it; the editor asks, defaulting to the branch.
Summaries fold in the table, and the network draws only working tasks.

*Sub-tasks to the WBS standard* (`reqs/sub_tasks.md`). A summary is the sum of its parts (the
100% rule), with no work of its own. Its status and actual dates are rolled up (`rolledUp`,
shared/wbs.ts) and stored by `replan`, so no view keeps a stale value, and the server refuses
a status, length, progress, actual date or environment sent for it. Its "start no earlier
than" holds every task under it (`inheritedFloors`, read by `scheduleProject`). The first
sub-task a task gains takes its environment, so the booking moves down to the work. A summary
left with no tasks becomes a task again with the length it last showed. **＋** on a row (shown
on hover and focus) and **Add sub-task** in the editor add a task last under it with the caret
in its name. There is no Tab to indent, because Tab moves focus (§5). An **Outline** menu shows
levels, **Show** adds a WBS column, and a summary's baseline is rolled up from its tasks'.

**Link types.** FS, SS and FF, with lag, in the After column as `2`, `2SS`, `2FF+1`. Scheduling
and float follow the type in both passes; the chart draws SS round the left and FF round the
right. The network still draws every link one way.

**Baseline and progress.** **Save baseline** copies every task's current dates into
`task_baseline`; scheduling never reads it. Progress is typed in the editor or worked out from
status (done 100, in progress by working days elapsed, capped at 95); a summary weighs its
tasks by length. Neither moves a date.

**Files.** Export writes CSV (the table's own columns and IDs) or MS Project XML (MSPDI:
outline, durations, links with type and lag, progress, "start no earlier than"). Import reads
either, parsed in the browser (`client/planIO.ts`), and appends the rows in one transaction and
one replan (`POST /api/projects/:id/import`), with the same outline and link rules as a hand
edit; an unknown environment books nothing and says so. Print uses a print stylesheet:
landscape, no toolbars, nothing sticky.

**Portfolio** (third tab). Every plan of the team on one chart: a project runs as a summary bar
from its first task to its last, with its target and how late it is, and opens to its tasks.
Read-only, computed without writing (`GET /api/teams/:id/portfolio`). Links between projects
are not modelled, so each project's arrows stay inside it.

**Network.** Activity-on-node boxes (early start, duration, early finish / name / late start,
float, late finish), columns by longest chain, rows by barycentre sweeps. Arrows are routed so
the drawing cannot lie: each source has its own vertical track in the gutter after it and each
long arrow's target its own track before it; an arrow that skips columns crosses them in a
clear gap between rows (or above or below everything), never through a box; arrows leave a
box just above its middle and arrive just below it, so a line leaving one box never lies on a
line arriving at a box level with it. Lines may cross; only arrows sharing a source or a
target share a line. Pointing at or focusing a task brings its own arrows forward.

The automatic layout is a starting point, not a verdict. A box can be dragged anywhere (it
snaps to an 8px grid; Alt+arrows move it from the keyboard), and an arrow, once clicked, shows
square handles for its first vertical run, its detour height and its last vertical run. Offsets
are stored relative to the boxes (`task.net_x/net_y`, `task_dependency.route_*`), so a shaped
arrow keeps its shape when a box moves; an arrow touching a moved box but never shaped is drawn
with sensible defaults, going round underneath when its target now sits to the left.
Arrangement is shared with everyone and never touches the schedule. **Reset arrow** and
**Reset layout** return to automatic.

**Smart Arrange** (`client/smartLayout.ts`) writes the tidiest drawing it can find as an
ordinary hand arrangement, so it can be tweaked, shared and undone like one. It is a layered
layout on a strict grid: columns by longest chain, with a task pulled right towards its
successors when that shortens arrows; an arrow that skips columns rides a *lane*, a row
reserved in every column it crosses and shared by one source's long arrows, so it is a straight
line through empty slots; rows ordered for fewest crossings (barycentre sweeps from several
starting orders, adjacent swaps, best kept); then whole rows chosen so arrows are level, the
critical path weighing most so it runs as one straight line. Arrows attach at three anchors per
side (`route_from`/`route_to`): the middle for a level arrow, the top quarter towards a row above,
the bottom quarter towards one below. Each gutter's vertical runs get their own tracks, ordered
for fewest crossings, and the gutter widens to fit. Arrows into one anchor from the next column
merge on one trunk, unless that would make a line run through a turn of arrows that share
neither a source nor a target; then they stay apart. Several candidates are scored (crossings,
then turns, then size) and the best is saved in one write (`PUT /api/projects/:id/layout`).
**Undo arrange** puts back exactly what it replaced, until another layout change. Hand arrangement applies to the plain view; with
environment lanes on, the lanes lay the boxes out. Tests
check this on the plan that first looked wrong and on random plans. **Show environments** puts each node in its environment's lane, in board
order, with "No environment" last. **Critical path only** dims the rest. Zoom steps, never
continuous. Arrow keys walk the graph and Enter opens a task. The one motion: critical arrows
draw once on open, behind reduced motion.

Rejected: a kanban board (wrong question), a red-filled critical path (red is spent; the red
critical lines above came later, by request), coloured status
pills (a rainbow dilutes the alarm).

## 17. Smart assistant

From `reqs/smart_assistant.md`, which has the design, the rules and the build plan. Phase 1
(warnings) is built: the engine in `shared/assistant/` reads the plan as it stands and names
risks by rule (progress, structure, schedule checks), each scored likelihood × impact.

**Where it sits.** A drawer beside the plan, opened by **Assistant** in the plan header, which
counts the open warnings in ink. The plan is the work surface, so the assistant is at hand and
never in the way; closed, it costs one button. On a phone the drawer stacks under the table,
like the board's.

**Colour.** None spent. Severity is a word (High, Medium, Low) and the weight of the card's left
edge: ink, muted, rule. A clash the assistant points at stays red on the board and in the strip;
the warning says so in words. **Show** marks the rows it names for a moment in `--focus`, the
colour that already means "here".

**Set aside, not delete.** A warning someone has looked at is set aside like an accepted
double-booking: still listed, greyed, no longer counted, and back when what it concerns changes.

Rejected: a red badge on the button (red is spent), a traffic-light "health score" (one number
hides which risk to act on), warnings inside the table cells (the table is for entering work).
