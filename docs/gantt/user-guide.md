# User guide

Plans → pick a project → **Tasks**. The table is on the left, the chart on the right.
Scroll the chart sideways; the table stays put.

## The toolbar

| Control | Does |
|---|---|
| **Days · Weeks · Months** | Zoom step. Days: week over M T W T F. Weeks: month over week. Months: quarter over month. The day at the left edge stays put when you switch |
| **Fit** | Picks the widest step that shows the whole plan and scrolls to its start |
| **Today** | Scrolls to this week (the chart also opens there) |
| **Show ▾** | Labels, Float, Baseline, Bookings, Environments. Remembered in this browser |
| **Find a task or person** | Filters rows by name, person or ID. A match keeps its summaries so the outline still reads |
| **Critical only** | Shows only critical tasks |
| **Save / Update baseline** | Keeps every task's current dates to compare against later |
| **Clear baseline** | Removes it (click twice: it arms first) |
| **Export ▾** | CSV for spreadsheets, MS Project XML, Print or save as PDF |
| **Import** | Adds tasks from a CSV or MS Project XML file after the last row |

The line under the table says how many rows the filter or a closed summary is hiding.

## Reading the chart

| Mark | Means |
|---|---|
| Coloured bar | A task, in its environment's colour |
| Hollow bar | A task on no environment: it books nothing |
| Faded bar | Done |
| Diamond | Milestone (0 days) |
| Black bracket | Summary task: spans the tasks under it |
| Red outline, red arrow | Critical path: any slip moves the finish |
| Dark band at the bar's foot | Progress so far |
| Thin line after a bar, ending in a tick | Float: how late it can finish without moving the project |
| Grey rule under a bar | Baseline dates; `+3d` after the label means it now finishes 3 working days later |
| Coloured wash behind a row | The environment booking this task belongs to (Show → Bookings); dashed when tasks made it |
| Pale block with a dashed edge at the end of a booking | Tasks are done but the booking runs on: click to release it |
| Dashed vertical line | Project target |
| Thin red line, "Today" flag | Today |
| Shaded column | Holiday |

Point at a bar (or tab to it) to trace its chain: everything it waits on and everything waiting
on it stay bright, the rest fades.

### Environments strip

Under the chart, one lane per environment this plan uses, **across the whole team**. Grey shows
how full it is each day; a red box is an open double-booking, a green one an accepted
double-booking. Hover for who and when.

## Changing the plan on the chart

| Do this | To |
|---|---|
| Drag a bar | Move it. It becomes the task's "start no earlier than" (or its actual start once work has begun). Length is kept |
| Drag a bar's right end | Change its length in working days (a done task: its actual finish) |
| Drag the dot after a bar onto another bar | Make that task come after this one (finish-to-start) |
| Click an arrow | Change its type (FS, SS, FF) or lag, or remove it |
| Click a bar | Open the task |

While you drag, a box beside the bar shows the new dates. Tasks that depend on it move with
it, and the Environments strip redraws. If the drop would double-book an environment, the box
says so in red, before anything is saved. After the drop, the banner says what the change did
and offers **Undo**.

A bar lands on working days. If something it waits for finishes later, it cannot start earlier
than that, and the box says "Held to … by what it waits for".

Summary bars cannot be dragged: their dates are their tasks'.

## Keyboard

| Where | Keys | Does |
|---|---|---|
| Table row | Alt+↑ / Alt+↓ | Move the task (and everything under it) among its siblings |
| Table row | Alt+Shift+→ | Put the task under the one above it |
| Table row | Alt+Shift+← | Take it out a level |
| Chart bar | Tab | Move between bars |
| Chart bar | Enter or Space | Open the task |
| Chart bar | Alt+← / Alt+→ | Move one day; pauses save as one change |
| Chart bar | Alt+Shift+← / Alt+Shift+→ | Shorten or lengthen by one day |
| Chart bar | Esc | Abandon the pending move |
| Divider | ← / → (Shift for bigger steps) | Resize table and chart |
| Divider | Home / End or Enter | Narrowest table / whole table |

## Sub-tasks and summary tasks

Add a sub-task with the **＋** that appears on a row when you point at it or tab into it, or
with **Add sub-task** in the task editor. The new task goes last under that row, with the caret
in its name. You can also put a task under another with Alt+Shift+→, by dragging its row number,
or with **Part of** in the editor. The task above becomes a summary, following the WBS rule
that a parent is the sum of its parts:

- its dates, float, critical flag, status, actual dates and progress come from the tasks under
  it, and the editor shows them rather than letting you type them;
- it books no environment. The first sub-task it gains takes its environment, so its booking
  moves down to the work instead of disappearing;
- its **Start no earlier than** holds every task under it;
- its Who reads as its **Owner**, the people accountable for it;
- the table says how many tasks it holds and how many are blocked, and the ▾ folds it.

Status rolls up as: done when every task is done, in progress once any has started (even if
another is blocked), blocked when one is blocked and none has started, otherwise to do.

A link *to* a summary holds every task under it; a link *from* one waits for all of them.
Those links are finish-to-start: a task linked start-to-start or finish-to-finish cannot become
a summary until that link is FS, and the refusal names the link. If you indent a task under
the task it was linked to, that link is removed, because a task cannot wait for its own
summary. When the last task leaves a summary, it becomes a task again, keeping the length it
last showed.

**Deleting a summary** asks what happens to its sub-tasks. **Go with it** (the default)
deletes the whole branch. **Stay, moved up a level** keeps them where the summary was. The
impact under the button covers the whole branch.

**Outline** in the toolbar opens everything or shows only the top levels. **Show → WBS
column** adds each task's outline number (1.2.3).

## IDs and the After column

Every task has an **ID**, shown next to the row number and editable in place or in the task
editor. A new task is offered the task count plus one (or the next free number); two tasks of a
plan cannot share one. After is written in IDs, not rows, so dragging a row somewhere else
never changes what a link says. Typing a number or part of a task's name in After lists the
matching tasks: ↑/↓ choose, Enter takes one, Escape closes the list.

| Write | Means |
|---|---|
| `2` | Start after task 2 finishes |
| `2+3` | Start three working days after task 2 finishes |
| `2-1` | Start one working day before task 2 finishes |
| `2SS` | Start when task 2 starts |
| `2SS+1` | Start a working day after task 2 starts |
| `2FF` | Finish no earlier than task 2 finishes |
| `2, 4SS` | Both |

## Moving rows

Drag a row number up or down: a line shows where it will land, and it goes above that row, at
that row's level, taking any tasks under it along. Dropping on a summary's first task puts it
under that summary. Escape cancels. Alt+↑/↓ does the same from the keyboard.

## Progress

Set **Progress, %** in the task editor, or leave it blank to work it out: done is 100, in
progress is working days elapsed over length (never more than 95), otherwise 0. A summary
weighs its tasks by length. Progress never moves dates.

## Files

**Export CSV** writes the table's own columns, including IDs and After, so it
re-imports as it was. **Export MS Project XML** opens in MS Project with the outline, lengths,
link types and lags, progress and "start no earlier than".

**Import** reads either format and adds the tasks after the plan's last row, all at once. CSV
headers are matched loosely (`Task` or `Name`, `Days` or `Duration`, `After` or `Predecessors`,
`Summary` or a `WBS` column like `1.2`, `Environment`, `Status`, `Progress`, `Resources` (or `Assignee`),
`Start no earlier than`, `Note`). An environment the team does not have is left out, and the
note after the import says so.

**Print** (Export → Print or save as PDF) prints landscape without toolbars. Months zoom fits a
long plan on the page; the divider's width is what prints.

## Portfolio

The **Portfolio** tab shows every project of the team: each as a black bracket from its first
task to its last, with a tick at its target and "Nd late" when it runs past it. ▸ opens a
project's tasks; its name opens its plan. Critical tasks and their arrows are red here too.
Read-only. Links between projects are not tracked yet.

## On a phone

The table becomes cards and the chart, strip and chart controls are hidden; search and
Critical only remain.
