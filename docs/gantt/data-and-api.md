# Data, API and files

## Schema additions

Defined in `server/schema.sql`; older databases get them from `server/db.ts` on start. All
additive: existing rows keep their meaning.

| Where | Column / table | Meaning |
|---|---|---|
| `task` | `parent_id INTEGER REFERENCES task(id) ON DELETE SET NULL` | The summary this task sits under. SET NULL is a safety net; deleting a summary lifts its children in `applyChange` |
| `task` | `progress INTEGER` (0–100, nullable) | Typed percent complete; NULL means worked out from status |
| `task_dependency` | `type TEXT NOT NULL DEFAULT 'FS'` (FS, SS, FF) | Link type. Old links read as FS |
| `project` | `baseline_at TEXT` | When the baseline was saved |
| `task_baseline` | `task_id` (PK), `project_id`, `start_date`, `end_date` | One snapshot per task; replaced on each save |

## Endpoints

New or extended for the chart. All task-changing routes replan in the same transaction.

| Method and path | Body | Returns |
|---|---|---|
| `GET /api/projects/:id/plan` | | Plan, now with `baseline: {task_id, start_date, end_date}[]` |
| `POST /api/tasks` · `PATCH /api/tasks/:id` | Also `parent_id`, `progress`, `predecessors: {id, lag, type}[]` | `{ id, plan }` |
| `DELETE /api/tasks/:id` | Query `bridge=1` keeps the chain; `children=delete` takes a summary's branch with it, `children=lift` (default) moves its tasks up a level | `{ plan }` |
| `POST /api/tasks/outline` | `{ project_id, placements: {id, parent_id, sort_order}[] }` | `{ plan }` |
| `POST /api/tasks/preview` | `{ project_id, change }`, where change may be `{ op: 'outline', placements }` or `{ op: 'delete', id, bridge, children }` | Impact |
| `POST /api/projects/:id/baseline` | | `{ plan }` |
| `DELETE /api/projects/:id/baseline` | | `{ plan }` |
| `POST /api/projects/:id/import` | `{ rows: ImportRow[] }` (at most 2000) | `{ plan, created, warnings }` |
| `GET /api/teams/:id/portfolio` | | `{ projects: { project, tasks, dependencies, schedule, finish, late_by }[] }`, computed, never written |
| `GET /api/board?team&from&to` | (existing) | Used for the Environments strip and the drag preview |

### Refusals worth knowing

| Situation | Message |
|---|---|
| Link between a task and its own summary (by hand) | "… are in the same summary line; link the tasks inside it instead" |
| SS or FF to or from a summary | "… would be a summary, and links to or from a summary are finish-to-start only: A → B is SS. Make that link FS first" |
| Status, length, actual dates, progress or environment sent for a summary | "… is a summary: its status comes from the tasks under it" (and the like) |
| A task under one of its own tasks | "… cannot sit under one of its own tasks" |
| Deeper than 8 levels | "An outline can be at most 8 levels deep" |
| Progress outside 0–100 | "Progress is a whole percentage, 0 to 100" |

An outline move (indent, **Part of**) that would create a task-to-own-summary link drops that
link instead of refusing.

A summary's `status`, `actual_start` and `actual_end` are written by `replan` from its tasks
(`rolledUp` in `shared/wbs.ts`), and its `progress` is kept NULL, so every reader (API, CSV,
MSPDI, portfolio) sees the rolled-up values. The server replans every plan that has summaries
on start, which fills these in for older rows.

## Import rows

Rows refer to each other by 1-based position in the import.

```ts
type ImportRow = {
  name: string;
  duration: number;                     // working days; 0 is a milestone
  environment?: string | null;          // by name, case-insensitive; unknown → none + warning
  parent?: number | null;               // a row above
  predecessors: { row: number; lag: number; type: 'FS' | 'SS' | 'FF' }[];
  resources?: string | null;            // the Who text, `Mai, Tuan`; new names become people
  status?: 'todo' | 'in_progress' | 'blocked' | 'done';
  progress?: number | null;
  not_before?: string | null;           // YYYY-MM-DD
  note?: string | null;
};
```

## CSV

Export columns, in order:

`ID, WBS, Task, Summary, Environment, Days, After, Start, Finish, Float, Status, Progress, Resources, Note`

`Summary` is the parent's ID; `After` uses the table's notation in IDs (`2`, `3+1`, `4SS`).
On import each task keeps the file's ID when it is free in the plan, and gets the next free
one otherwise.
Start, Finish and Float are for reading; import ignores them (dates are scheduled).

Import accepts commas, semicolons or tabs, quoted cells and a BOM. Header aliases:

| Field | Headers accepted |
|---|---|
| Name | Task, Name, Task name, Title |
| Days | Days, Duration, Working days (`3`, `3d`, `3 days`) |
| After | After, Predecessors, Depends on |
| Parent | Summary, Parent, Summary row, Parent row; or a `WBS` / `Outline` column (`1.2` sits under `1`) |
| Environment | Environment, Env |
| Status | Status (To do, In progress, Blocked, Done, and common synonyms) |
| Progress | Progress, % complete, Percent complete, % |
| Start no earlier than | Start no earlier than, Not before, SNET |
| Resources | Resources, Who, Assignee, Assigned to, Owner, Resource, Resource names (`Mai, Tuan`: commas or semicolons between names) |
| Note | Note, Notes |

If the file has an `ID` (or `Row`, `#`) column, After and Summary refer to it; otherwise to line positions.

## MS Project XML (MSPDI)

| Plan | MSPDI |
|---|---|
| Row number | `UID`, `ID` |
| WBS, depth | `OutlineNumber`, `OutlineLevel` (depth + 1) |
| Summary / milestone | `Summary`, `Milestone` |
| Scheduled dates | `Start` (T08:00), `Finish` (T17:00) |
| Days | `Duration` `PT{days×8}H0M0S`, `DurationFormat` 7 |
| Progress | `PercentComplete` (typed, else 100 when done) |
| Start no earlier than | `ConstraintType` 4 + `ConstraintDate` |
| Note | `Notes` |
| Link | `PredecessorLink`: `PredecessorUID`, `Type` (0 FF, 1 FS, 3 SS), `LinkLag` in tenths of a minute (4800 per day), `LagFormat` 7 |

Import skips the project summary row (UID 0 / level 0), builds parents from outline levels,
turns SF links (type 2) into FS with a warning, and reads `ConstraintType` 2 or 4 as "start no
earlier than". A task with 100% becomes done.
