# Sub-tasks in the task list

Requirement, solution and impact assessment. Drafted 2026-09-30 and built the same day, with
every recommendation in §7 accepted. The notes below say where the build differs from the plan.
Builds on the summary tasks in `DESIGN.md` §16 (Outline) and `reqs/gantt_chart.md`.

## 1. Where we start

The data model already supports sub-tasks. `task.parent_id` makes a task a **summary**, and
`shared/wbs.ts` reads the outline depth-first. It already handles:

- indent and outdent (Alt+Shift+→/←), moving among siblings (Alt+↑/↓), dragging rows, and the
  editor's **Part of** field
- WBS numbers (1, 1.1, 1.2), up to 8 levels deep
- rolling up dates, float and criticality; a summary books nothing
- rolling up progress, weighted by length
- showing a rolled-up status in the table
- expanding links to or from a summary onto its tasks, FS only
- folding summaries in the table, drawing a bracket bar on the Gantt chart, and drawing only
  working tasks in the network
- CSV and MSPDI outline in and out

So this feature does not add a new concept. It finishes the existing one to project
management standard and makes it easy to find: today you can only make a sub-task by
indenting a row, and several summary fields can be edited but are then ignored.

## 2. The standard applied

The rules come from the PMBOK WBS practice and the PMI Practice Standard for Scheduling, as
MS Project, OpenProject and Smartsheet apply them:

| # | Standard rule | Meaning here |
|---|---|---|
| S1 | **Decomposition.** A task broken into sub-tasks becomes a summary (a WBS element). The lowest level holds the work (the work package or activity). | A task with children is a summary; only leaves are scheduled, booked and progressed. |
| S2 | **The 100% rule.** A parent holds exactly the sum of its children: no work of its own, nothing outside them. | A summary has no duration, environment, effort or progress of its own. Everything shown on it is rolled up. |
| S3 | **Roll-up.** Start = earliest child start. Finish = latest child finish. Progress = duration-weighted. Status and actuals are derived. | Everything is derived, never typed, and stored consistently so every reader agrees. |
| S4 | **Constraints cascade down.** A date constraint on a summary applies to every task under it. | A summary's "start no earlier than" holds all of its tasks. |
| S5 | **Link the work, not the summary.** Logic belongs on activities. Summary links are allowed, but FS only. | Already the case (`expandLinks`, FS only). Keep it. |
| S6 | **Deleting a summary deletes its branch.** The user is warned and told how much goes with it. | Offer both **delete the branch** and **keep the sub-tasks**, and state the count. |
| S7 | **Sensible depth.** 3 to 5 levels is normal. Deeper is usually a mistake. | Keep `MAX_DEPTH = 8`. |
| S8 | **The WBS code is the address.** It is shown, exported and stable in outline order. | Add an optional WBS column. It is already exported. |
| S9 | **Summary owner.** The summary names who is accountable. The tasks under it name who does the work. | A summary's assignee reads as its **Owner**. |

A Jira-style checklist item (a to-do inside a task with no dates) is **not** part of this
standard and is out of scope. If it is wanted later, it belongs in a separate
`task_checklist` table so it can never reach scheduling.

## 3. Requirements

Status: **Built**, **Gap** (build it), **Fix** (it exists but breaks a rule above).

### Creating and arranging

| ID | Requirement | Status |
|---|---|---|
| R1 | **Add sub-task** on any row: a row action (＋ beside the name, shown on hover and focus) and a button in the task editor. It creates a new task as the last child and puts the caret in its name. | Gap |
| R2 | The first sub-task added to a task that has an environment **inherits that environment**. This way the booking moves down to the work and does not vanish (S2). | Gap |
| R3 | Indent, outdent, reorder, drag and **Part of** keep working as they do now. | Built |
| R4 | Turning a task into a summary shows the impact before saving: its N days stop counting, booking X on ENV shrinks or goes, and any SS/FF link that has to become FS. | Fix: indenting under a task with an SS/FF link is refused with a generic message that names neither link |
| R5 | When the last sub-task leaves, the summary becomes a task again, with **Days set to its last rolled-up length**, not a stale value from before it became a summary. | Fix |

### What a summary shows and allows

| ID | Requirement | Status |
|---|---|---|
| R6 | Read-only on a summary: Days, Start, Finish, Float, Status, Progress, Environment. The table does this; the **editor** must do it too. | Fix: the editor still offers Status on a summary, which is saved and then ignored |
| R7 | Editable on a summary: name, ID, Part of, After (FS only), **Start no earlier than** (applies to all of its tasks, S4), Owner (assignee), note. | Fix: `not_before` on a summary is saved and then silently ignored by scheduling |
| R8 | Rolled-up status is **stored** on the summary by `replan`, so the API, CSV, MSPDI and portfolio all read the same value. Rule: *done* when all tasks are done; *blocked* when any task is blocked and none is in progress; *in progress* when any task has started; otherwise *to do*. | Fix: the rule runs only in `Plan.tsx`, and the stored `status` is stale |
| R9 | Rolled-up actuals: actual start is the earliest actual start among its tasks. Actual finish is the latest actual finish, once every task is done. | Gap |
| R10 | A summary shows a quiet count of what is under it (for example "4 tasks, 1 blocked") so a folded summary still tells you what is inside. | Gap |

### Viewing

| ID | Requirement | Status |
|---|---|---|
| R11 | A **WBS** column (1.2.3), switched under **Show** and remembered. | Gap |
| R12 | **Outline level** control: All, Level 1, Level 2, Level 3, plus Expand all and Collapse all. | Gap (only one-by-one folding today) |
| R13 | A filter shows matching rows with their summaries (this exists). A sub-task under a folded summary stays hidden. | Built |
| R14 | Gantt: the summary bar is a bracket (exists). The **summary baseline** rolls up from its tasks' baselines. | Check: verify what `task_baseline` holds for summaries |

### Deleting

| ID | Requirement | Status |
|---|---|---|
| R15 | Deleting a summary offers two choices, each with server counts: **Delete with its N sub-tasks** (the standard, S6) or **Keep the sub-tasks** (they move up a level, as they do today). `DangerButton` arms, states the cascade and disarms, as elsewhere. | Gap |
| R16 | The delete impact covers the whole branch: dates that move, bookings that shrink or go, and **accepted double-bookings that would stop being accepted**. | Gap |

### Files

| ID | Requirement | Status |
|---|---|---|
| R17 | CSV and MSPDI export write the stored rolled-up status and a summary's constraint. Import applies a summary's constraint to its tasks (S4). | Fix |

## 4. Solution

There are **no new tables**. The work adds one shared rule module, a handful of `replan`
steps, a delete option and UI.

### 4.1 Shared (pure, used by both sides)

`shared/wbs.ts`:

- `rolledStatus(leaves)` moves here from `Plan.tsx`, so there is one rule.
- `inheritedFloor(tasks, id)` returns the latest `not_before` among a task and its ancestors.

`shared/schedule.ts`:

- A leaf's effective `not_before` is `inheritedFloor`, so a summary's constraint holds every
  task under it. This is the only scheduling change. The drag preview and the preview endpoint
  get it for free, because they already run `scheduleProject`.
- The roll-up block adds `status`, `actual_start` and `actual_end` to the summary's
  `TaskSchedule`.

`client/gantt.ts`: `rolledProgress` stays where it is (display only).

### 4.2 Server

`server/plan.ts`:

- **`replan` writes the rolled-up status and actuals for summaries**, in the same UPDATE that
  already writes their dates (line ~89). This makes `replan` the only writer of summary status,
  in the same way it is the only writer of task dates.
- **`applyChange` `create` with `parent_id`** (R1) already puts the new task last under its
  summary. Add R2: if the parent has no children yet and has an `environment_id`, the new
  child takes it. `checkOutline` then clears the parent's environment as it does today.
- **Reverting a summary** (R5): after any change, a task that was a summary and has no
  children left gets `duration = workingDays(its last rolled-up start and end)`.
- **`delete` gains `children: 'lift' | 'delete'`**. `'lift'` is today's behaviour. `'delete'`
  removes the task and all its `descendants` in one change, so there is one replan and one
  impact.
- **`checkOutline`**: when a task becomes a summary and an SS or FF link blocks it, the error
  names that link (R4).
- **`fields` on a summary**: refuse `status`, `progress`, `duration`, `environment_id`,
  `actual_*` with a clear message. The UI never sends them; this stops scripts and imports
  writing values that are then ignored.

`server/routes.ts`:

- `previewTask` delete accepts `children` and returns `descendant_count`,
  `bookings_affected` and `resolutions_lost` (R16). The impact already works out moved dates
  and bookings; resolutions lost comes from comparing `conflictKey`s before and after, using
  the same `applyResolutions` path.
- The task list returns `child_count` for summaries (R10, R15), in the same way projects return
  `booking_count`.

`server/db.ts`: on start, call `replanAll` once. This backfills the rolled-up status on
existing summaries (it already runs on migrations).

### 4.3 Client

`client/components/Plan.tsx`:

- Row action **＋ Add sub-task** (R1). It is a button in the name cell, visible on hover and
  focus-within, and it is keyboard-reachable. There is no Tab/Shift+Tab indent: Tab must keep
  moving focus (`DESIGN.md` §5).
- Editor: for a summary, hide Status and Progress, relabel Assignee to **Owner**, keep
  **Start no earlier than** with the hint "Holds every task under it", and add an
  **Add sub-task** button (R6, R7).
- The status cell reads the stored status. The local `rolled` computation goes (R8).
- The summary name cell gets a count line (R10).
- A **WBS** column under Show (R11). An **Outline** menu next to Show with levels and
  expand/collapse all (R12). It reuses `collapsed` in localStorage: a level choice becomes the
  set of summaries at that depth or deeper.
- Delete a summary: two `DangerButton`s, "Delete with 4 sub-tasks" and "Keep sub-tasks".
  Each fetches its own preview (R15, R16).

`client/components/Gantt.tsx`: a summary baseline rule from min/max of its tasks' baselines
(R14). The bars need no other change.

`client/planIO.ts`: export the stored status. MSPDI writes `ConstraintType`/`ConstraintDate`
on summaries. Import pushes a summary constraint into `not_before` on the summary itself, and
scheduling cascades it (R17).

### 4.4 What deliberately does not change

- **Conflict detection, holds, bookings and `reconcileBookings`.** Summaries are already left
  out of holds, and only leaves book. Auto bookings keep their ids through overlap matching,
  so adding or moving sub-tasks does not un-accept double-bookings. Deleting a branch can, and
  R16 says so before it happens.
- **The network diagram** stays leaves only. That is the standard for precedence diagrams.
- **Link rules**: FS only on summaries, and no link between a task and its own summary.

## 5. Impact assessment

| Area | Files | Change | Size | Risk |
|---|---|---|---|---|
| Outline rules | `shared/wbs.ts` | `rolledStatus`, `inheritedFloor` | S | Low |
| Scheduling | `shared/schedule.ts` | Inherited `not_before`, rolled status and actuals on summaries | S | **Medium**: every plan with a summary constraint can move. Today's constraints on summaries are ignored, so turning them on moves those plans once. Report it on first start. |
| Replan and writes | `server/plan.ts` | Store rolled fields; revert duration; env inheritance; delete branch; refuse summary-only fields; better SS/FF message | M | Medium: replan is the choke point. Keep it in the same transaction. |
| API | `server/routes.ts`, `client/api.ts`, `shared/types.ts` | `children` on delete; counts in preview and task list | S | Low |
| Migration | `server/db.ts` | `replanAll` backfill | XS | Low |
| Task table | `Plan.tsx`, `styles.css` | Add sub-task action, WBS column, outline menu, count line, stored status | M | Low. No new colour; counts are in ink. |
| Task editor | `Plan.tsx` | Summary field set, Owner, Add sub-task, two-way delete | S | Low |
| Gantt chart | `Gantt.tsx`, `gantt.ts` | Summary baseline roll-up | XS | Low |
| Import/export | `planIO.ts` | Stored status; summary constraint in MSPDI | S | Low |
| Board, conflicts, bookings | `shared/conflicts.ts`, `taskHolds.ts`, `Board.tsx` | **None** | — | — |
| Network, Smart Arrange | `network.ts`, `smartLayout.ts` | **None** (leaves only) | — | — |
| Portfolio | `Portfolio.tsx`, portfolio route | None needed. It gains the right status for free. | — | — |
| Tests | `tests/wbs.test.ts`, schedule, plan, planIO | Roll-up rule; cascade constraint; revert duration; delete branch vs lift; env inheritance; summary-field refusal; MSPDI constraint round trip | M | — |
| Docs | `DESIGN.md` §16 Outline, `CLAUDE.md` summary rule, `docs/gantt/user-guide.md`, `data-and-api.md` | Update the rules | S | — |

**Before starting:** the working tree has uncommitted work on TaskIDs and row drag
(`shared/taskCode.ts`, `wbs.ts` `moveBefore`, `Plan.tsx`). Commit that first so this feature
starts from a clean base.

## 6. Build order

1. **Correctness** (the Fix rows): stored rolled status, editor field set, cascading
   constraint, revert duration, SS/FF message, summary-field refusal, migration. Nothing new is
   visible yet, but every view starts to agree.
2. **Creation**: Add sub-task (row and editor) and environment inheritance.
3. **Deleting**: delete the branch or keep the sub-tasks, with the full impact.
4. **Viewing**: WBS column, outline levels, count line, summary baseline.
5. **Files**: MSPDI constraints and status.

## 7. Decisions needed

| Question | Recommendation |
|---|---|
| Default when deleting a summary: delete the branch, or keep the sub-tasks? | Show both. Put **Delete with sub-tasks** first, as in the standard, and keep the existing lift as the second choice. |
| Does the first sub-task inherit the parent's environment? | Yes, so the booking does not silently disappear. Later sub-tasks do not inherit it. |
| Should a summary's "start no earlier than" cascade? | Yes (S4). Tell users once that plans with such constraints may move. |
| Rolled-up status when one task is blocked and another is in progress? | *In progress*, with "1 blocked" in the count line. The alternative is *blocked*. |
| Checklist sub-tasks (no dates)? | Out of scope. If they are wanted, build them in a separate table later. |

## 8. As built

All five phases are built. Differences from the plan above:

- **No new counts from the server.** The client already holds the whole plan, so the sub-task
  count (R10, R15) is worked out from `plan.tasks`, and the delete preview carries the branch
  through `deletedTaskIds`.
- **Accepted double-bookings a delete would reopen** (R16) need no new field. The impact's
  `conflicts_added` already compares open conflicts with resolutions applied, so a reopened
  clash is named in red.
- **The environment passes down on an indent as well as on Add sub-task**, but only to a task
  that has no environment of its own and has just joined the new summary.
- **Files** needed no change. CSV and MSPDI write the stored status, which is now the rolled-up
  one, and MSPDI already wrote and read `ConstraintType`/`ConstraintDate` on summaries.
  Scheduling now applies that constraint to the summary's tasks.
- **Deleting a summary** is one danger button with a choice above it (**Go with it**, the
  default, or **Stay, moved up a level**), not two buttons. The button says how many go.

Tests: `tests/subTasks.test.ts` covers the roll-up rule, the cascading constraint, the stored
status, environment handover, refused fields, reverting a summary, branch versus lift delete,
the bridged chain and the named SS/FF refusal. `tests/gantt.test.ts` covers the rolled-up
baseline.
