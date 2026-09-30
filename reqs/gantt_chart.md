# Gantt chart for the plan's Tasks view

The requests as they were made, and the decisions taken on them. Built 2026-09-29.
How it works: [`docs/gantt/`](../docs/gantt/README.md). Design and rules: `DESIGN.md` §16.4.

## What was asked, in order

1. In Plans → Tasks, add a Gantt chart to the right of the task list, with horizontal scroll,
   in the style of a classic weekly Gantt (week header over M T W T F, bars, milestones as
   diamonds, arrows between dependent tasks).
2. A draggable divider between the table and the chart.
3. A clearer today line.
4. Brainstorm what the leading IT project tools (MS Project, Jira Plans, Smartsheet, Wrike,
   GanttPRO, TeamGantt, OpenProject) treat as standard for a Gantt chart.
5. Build all phases of that brainstorm.
6. Show the critical path in red: bar outlines, then chart links, then the network diagram's
   arrows, then the portfolio's bars and arrows.

## Decisions

| Question | Decision |
|---|---|
| Weekend columns | Left out. Task spans are working days, so a Friday bar meets the next Monday bar. Holidays keep their column, shaded |
| Link colour | Ink, not orange as in the reference image: warm hues sit too near the double-booking red |
| Critical path colour | Red **lines** by request: bar outlines and arrows on the chart, network and portfolio. Never a red fill, so it cannot read as a double-booking |
| Summary tasks | Yes, via `task.parent_id`. A summary rolls up, books nothing, and its own length stops counting |
| Links to a summary | Allowed, finish-to-start only; they reach every task under it. A link between a task and its own summary is refused (or dropped by an outline move) |
| Link types | FS, SS, FF. SF is not supported (imports turn it into FS, with a note) |
| Progress % | Typed in the task editor; blank means worked out from status (done 100, in progress by working days elapsed, capped at 95) |
| Baselines | One per project, replaced on save. Scheduling never reads it |
| Files | CSV and MS Project XML (MSPDI), both ways; print to PDF through a print stylesheet |
| Cross-project links | Not built: they need replans to cascade across projects. The portfolio shows plans side by side, read-only |
| Phone | Chart, strip and chart controls hidden; the table stays as stacked cards |

## Brainstorm, and what became of it

| Phase | Items | Status |
|---|---|---|
| 1. Quick wins | Float tails, labels, chain highlight, zoom steps, Fit and Today, filter | Built |
| 2. Editing on the chart | Drag to move, resize, link; click a link to edit it; keyboard; live impact with double-booking warning | Built |
| 3. What makes this app different | Environments occupancy strip, bookings behind bars, release from the chart | Built |
| 4. Model changes | Summary tasks, SS/FF links, baselines and variance, progress % | Built |
| 5. Reach | CSV and MS Project import/export, print, portfolio | Built |
| 5. Reach | Cross-project links | Open |
| Not planned yet | Resource levelling, SF links, several baselines, virtualised rows, grouping by environment or person, progress line | Open |

Deliberately not copied: a red-filled critical path, coloured status bars, continuous zoom,
automatic levelling that silently moves tasks, a second scheduling engine in the chart.
