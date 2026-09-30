# Architecture

How the chart is built, which module owns what, and the rules that keep it honest. The
short, must-not-break versions of these rules live in `CLAUDE.md`; this page explains them.

## Principle: one engine, many views

The chart never computes a date, a hold or a double-booking itself. Scheduling, holds and
conflicts live in `shared/`, imported by both the server and the browser, so what the chart
predicts during a drag is what the server writes on the drop.

```
                        shared/ (pure, imported by server AND client)
   ┌─────────────┐   ┌─────────────┐   ┌──────────────┐   ┌───────────────┐
   │   wbs.ts    │──►│ schedule.ts │──►│ taskHolds.ts │──►│  conflicts.ts │
   │  outline    │   │ CPM, types, │   │ holds,       │   │ sweep line,   │
   │  summaries  │   │ summaries   │   │ isManaged    │   │ occupancyByDay│
   └─────────────┘   └─────────────┘   └──────────────┘   └───────────────┘
                              └─────────── plan.ts ────────────┘
                     planProject · planImpact · bookingsFor · conflictsFor
              ▲                                                   ▲
   server/plan.ts: applyChange → writeState → replan    client: drag preview, strip
```

## Files

| File | Owns |
|---|---|
| `shared/wbs.ts` | The outline: `outline`, `inOutlineOrder`, `summaryIds`, `descendants`, `leavesOf`, `indent`, `outdent`, `moveAmongSiblings`, `MAX_DEPTH` |
| `shared/schedule.ts` | `scheduleProject` (link types in both passes, summaries rolled up), `expandLinks`, `linkType` |
| `shared/plan.ts` | `planProject`; `bookingsFor` and `conflictsFor` (the team's bookings and clashes as an outcome would leave them); `conflictChanges` |
| `shared/taskHolds.ts` | `isManaged`: which bookings a plan may reshape (server and preview both ask) |
| `shared/conflicts.ts` | `occupancyByDay` for the strip, beside `detectConflicts` |
| `server/plan.ts` | `applyChange` (ops: create, update, delete, **outline**), `checkOutline`, `writeState`, `replan` |
| `server/routes.ts` | Outline, baseline, import, portfolio routes; `parent_id`, `progress`, link `type` validation |
| `client/gantt.ts` | Pure chart maths: scale, zoom steps and header bands, grid lines, drag dates, `startFields` / `finishFields`, variance, progress, chain tracing, row visibility |
| `client/planIO.ts` | CSV and MSPDI, both directions |
| `client/predecessors.ts` | The After column's notation, now with SS/FF |
| `client/components/Gantt.tsx` | The chart: drawing, gestures, keyboard, strip, link editor, readout |
| `client/components/Plan.tsx` | `PlanView` (state, save, preview, files), `TaskTable` (toolbar, table, divider, row measuring), `TaskEditor` |
| `client/components/Portfolio.tsx` | The team chart |

## How the table and chart line up

The table and chart share one scroll container (`.task-split`). The table's wrapper is
`position: sticky; left: 0`, so the chart scrolls sideways under it; both headers are sticky to
the same container, so they scroll vertically together.

The chart does not lay out rows. `TaskTable` measures every `tr[data-task]` (`offsetTop`,
`offsetHeight`) with a `ResizeObserver` and passes the boxes to `Gantt`, which draws each bar at
its row's middle. A row that grows (an "overdue" note) or disappears (filter, folded summary)
moves the chart with it. The table header is 48px to fit the chart's two header rows.

The divider narrows the table's wrapper, which uses `overflow-x: clip` (not `hidden`: hidden
would make it a scroll container and unstick the header).

## How an edit on the chart is saved

```
pointer / Alt+arrow
   │  draggedStart / draggedFinish        (client/gantt.ts: lands on working days)
   ▼
startFields / finishFields               (same fields a typed date makes)
   │                    │
   │ while dragging     │ on drop
   ▼                    ▼
preview(t, fields)      setStart / setFinish (Plan.tsx)
  planProject             → previewTask (impact) → updateTask → replan (server)
  bookingsFor              → impact banner + Undo
  conflictsFor
  conflictChanges.added  → red "Double-books …" in the readout
```

The preview keeps the scale fixed (it follows the saved plan, not the drag), so the ground does
not move under the pointer. The preview stays up until the save answers, so nothing jumps.

A 4px slop decides click versus drag; a click opens the task.

## Summaries in scheduling

1. `summaryIds` finds tasks with children.
2. `expandLinks` rewrites every link that touches a summary onto its working tasks
   (`leavesOf`).
3. `scheduleProject` schedules only working tasks, with those links.
4. Each summary's start, end, late dates, float and critical flag roll up from its tasks.
5. `planProject` leaves summaries out of `taskHolds`, and `checkOutline` clears their
   environment on every write.

The network diagram draws working tasks only, with the expanded links (keeping hand-shaped
routes where a link was already task-to-task).

## Invariants

- Rows are numbered in outline order (`inOutlineOrder`), everywhere: table, MSPDI.
  `sort_order` only orders siblings. After and CSV use TaskIDs (`task.code`, `shared/taskCode.ts`).
- Every write that can move dates goes through `commit` → `replan` in one transaction,
  including outline moves and imports.
- `checkOutline` runs after every change: parent in the project, no loops, depth ≤ 8, no link
  between a task and its own summary, summary links FS only, summaries book nothing.
- Baselines and progress never feed scheduling.
- Every loop over the scale is bounded (`ganttScale` caps at 520 weeks; bands and grid lines
  walk the day list once).

## Colour

Environment hues on bars; ink for structure (summaries, progress, links, target); grey for
baseline, float and occupancy. Red is the double-booking alarm, with three thin exceptions,
all lines, never fills: today (`--today`), and the critical path's bar outlines and arrows
(`--critical-outline`, by request) on the chart, network and portfolio. Accepted
double-bookings are green (`--resolved`).

## Client state kept in the browser

| `localStorage` key | Holds |
|---|---|
| `plan.chart` | Zoom step and the Show switches |
| `plan.tableWidth` | Divider position |
| `plan.collapsed.<projectId>` | Folded summaries |

All reads and writes are wrapped in `try`; the page works without them.
