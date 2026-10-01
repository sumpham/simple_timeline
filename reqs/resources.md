# Resources on tasks

Requirement, solution and impact assessment. Drafted 2026-09-30 and built the same day, with
every recommendation in §8 accepted. §9 says where the build differs from the plan. Builds on the task table (`DESIGN.md` §16) and the summary-owner rule
in `reqs/sub_tasks.md` (S9).

## 1. Where we start

A task already has `task.assignee`: one free-text string. It is typed in the task editor, shown
as a grey name beside the task name, drawn after the bar on the Gantt chart (`· Mai`), matched
by the find box and read from CSV (`assignee`, `owner`, `resource`, `resource names`). MSPDI
does not write it at all.

That is enough to label a task, but nothing else can use it:

- `"Mai, Tuan"` is one string, so no feature can tell that Mai has three tasks next week.
- `"Tuan"` and `"tuan "` are different people.
- Renaming a person means editing every task by hand.
- There is no list of people to pick from, so every entry is a chance to make a typo.

## 2. What is asked

1. Put the people who do a task **on the task, typed inline** the way After is: one cell,
   comma-separated, no dialog.
2. **Several people can share a task.**
3. The application **builds the resource list by itself** from what is typed. Nobody has to set
   up people first.
4. The resource list is the base for **later management features**: workload, over-allocation,
   levelling, "my tasks", a per-person portfolio.

Point 4 decides the design. A comma-separated string is easy to type but useless for querying,
so the text is only the **input format**. What gets stored is a proper resource table and an
assignment table.

## 3. Requirements

| ID | Requirement |
|---|---|
| R1 | A **Who** column in the task table, edited in place like After: `Mai, Tuan Nguyen`. It commits when you leave the cell, and Escape reverts. |
| R2 | The column splits on `,` and `;` only. Spaces stay inside a name, so `Tuan Nguyen` is one person. Names are trimmed, inner spaces are collapsed, and repeats are dropped. The order typed is kept. |
| R3 | A name the app has not seen before **creates a resource** when the task is saved. A known name, matched **ignoring case**, links to the existing resource and keeps its stored spelling. |
| R4 | While you type, the cell **suggests** known people for the name under the caret, the same way After suggests tasks. A new name shows as **＋ New: Tuấn**. When a new name is close to a known one (same letters without accents, or one letter different), the list shows **Tuan?** first. This stops `Tuấn` and `Tuan` becoming two people by accident. |
| R5 | The task editor has the same field, with the same suggestions. On a summary it is labelled **Owner** (S9 in `reqs/sub_tasks.md`). |
| R6 | A **Resources** manager dialog, the same shape as Teams, Projects and Environments (`Dialogs.tsx`). It shows each person's name, number of tasks, number of projects, and whether they are active. From it you can **rename** a person (every task follows, because tasks link by id), **merge** one person into another (for typos), and **delete** a person with `DangerButton`, which says how many tasks lose them. |
| R7 | A person with no tasks **stays in the list**, shown as *unassigned*, so later attributes such as capacity or days off are not lost when a cell is cleared. You delete them yourself. |
| R8 | The find box matches any assigned person's name, as it matches `assignee` today. |
| R9 | The Gantt label shows `· Mai, Tuan`. With more than two people it shows `· Mai +2`, and the tooltip lists them all. |
| R10 | CSV writes and reads the column as `Mai, Tuan`. MSPDI writes and reads real `<Resources>` and `<Assignments>` blocks, the way MS Project does. |
| R11 | Changing who does a task **never moves a date**, runs `replan`, or shows an impact banner. |
| R12 | Existing data migrates on start. Each `assignee` string is split by R2 and becomes resources and assignments, so seed data and user plans read the same as before. |

## 4. Solution

### 4.1 Data model (`server/schema.sql`)

```sql
-- A person (or later, any named resource) who does work on tasks. Made
-- automatically the first time a name is typed on a task (shared/resources.ts).
CREATE TABLE IF NOT EXISTS resource (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,              -- as first typed, or as renamed
  name_key   TEXT    NOT NULL UNIQUE,       -- resourceKey(name): the match key
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Who does a task. Order is the order typed in the Who column.
CREATE TABLE IF NOT EXISTS task_resource (
  task_id     INTEGER NOT NULL REFERENCES task(id)     ON DELETE CASCADE,
  resource_id INTEGER NOT NULL REFERENCES resource(id) ON DELETE CASCADE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (task_id, resource_id)
);

CREATE INDEX IF NOT EXISTS idx_task_resource_res ON task_resource(resource_id);
```

- **Resources are global, not per team.** One person works across teams and projects. Workload
  and levelling have to count all of a person's work, so scoping resources to a team would
  split the same person into several. A `team_id` home team can be added later as a filter,
  not as a key.
- `task.assignee` is **dropped** after migration (`ALTER TABLE … DROP COLUMN`). If it were kept
  as a mirror, two sources of truth would drift apart.
- `resource` deliberately has **no capacity, rate or calendar yet**. Those come with the
  features that read them (§7). The table has a stable id, so they are plain column additions.

### 4.2 Shared rules (`shared/resources.ts`, new, pure)

Both sides import this module, as they do After's parser, so the cell, the import and the
server agree by construction.

- `resourceKey(name)`: NFC-normalise, trim, collapse whitespace, lower-case. This is the one
  match rule (R3).
- `parseResources(text)` returns `{ ok, names[] }` or `{ ok: false, error }`. It splits on
  `[,;]`, drops blanks and duplicate keys, and limits each name to 60 characters and each task
  to 20 names. **It refuses `[` and `]` inside a name.** That keeps the MS Project allocation
  form (`Mai[50%]`) free to add later without breaking anyone's data.
- `formatResources(ids, byId)` returns `"Mai, Tuan"`. It writes the Who cell, CSV and the Gantt
  label.
- `resourceSuggestions(text, caret, resources)` returns the known people for the name under the
  caret, plus the **near match** for a new name: the same key after stripping accents, or an
  edit distance of 1 (R4).

### 4.3 Server

- **`ensureResources(db, names)` → ids** (`server/resources.ts`). It looks up each name by
  `name_key`, inserts the ones not found, and returns the ids in the order typed. This is the
  only place resources are created automatically.
- **Task writes** (`server/routes.ts`): create, update and import accept `resources: string[]`,
  or a string that goes through `parseResources`. The route writes `task_resource` in the
  **same transaction** as the task change (delete this task's rows, then insert them in order).
  It does this **outside `applyChange`**: resources are not plan state, so `replan`,
  `scheduleProject` and the preview endpoint never see them (R11). An update that changes only
  resources skips `replan`.
- **Reads**: the plan payload adds `resources: Resource[]` (the people this project uses) and
  `task.resource_ids: number[]`. The portfolio payload adds the same, so a person's name can be
  shown anywhere without a second request.
- **Routes** (the same shape as the other managers):
  - `GET /api/resources` lists every resource with `task_count` and `project_count`, for the
    dialog and for suggestions.
  - `PATCH /api/resources/:id` changes `{ name, active }`. A rename onto an existing key returns
    409 and offers a merge.
  - `POST /api/resources/:id/merge { into }` moves the assignments with `INSERT OR IGNORE`, then
    deletes the source.
  - `DELETE /api/resources/:id` removes the resource. The cascade removes its assignments;
    `task_count` has already told the user how many.
- **Audit**: assignment changes are logged as `entity = 'task', field = 'resources'`, with the
  old and new text formed by `formatResources`.
- **Migration** (`server/db.ts`), on start and once. If `task.assignee` exists, the server runs
  every non-null value through `parseResources` and `ensureResources`, inserts the assignments
  and drops the column, all in one transaction. Like `fillTaskCodes`, older databases then
  read as they did before.

### 4.4 Client

- **`ResourceInput` / `ResourceCell`** in `Plan.tsx` are modelled on `AfterInput` /
  `AfterCell`: the same commit-on-leave, the same suggestion list and keyboard handling, and the
  same `data-label` for the phone layout. The "name under the caret" is the text between the
  nearest commas.
- **Table**: a **Who** column after After. It can be switched off under **Show**, and that
  choice is remembered in `ChartPrefs` like the WBS column. The grey assignee text beside the
  name goes, because the column replaces it.
- **Editor**: the Assignee input becomes the same `ResourceInput`, labelled **Owner** on a
  summary.
- **No new colour.** Names are ink text, and multiple people are a comma list, not coloured
  chips or avatars. Colour is spent on double-bookings (`DESIGN.md` §6, §11). Giving every
  person a hue would compete with the alarm.
- **Resources dialog**: a fourth manager in `Dialogs.tsx`, opened from the same menu as Teams,
  Projects and Environments. Merge is a select ("Merge into…") and a confirm button, with no
  `confirm()`.
- `client/api.ts` and `shared/types.ts` gain `Resource`, `resource_ids` and the new routes.
  `Task.assignee` is removed.

### 4.5 Files (`client/planIO.ts`)

- **CSV**: the existing `assignee` column becomes **Resources** and uses the same aliases on
  import. Export writes `formatResources`. Import uses `parseResources`, and the server resolves
  the names.
- **MSPDI**: export writes `<Resources>` (UID, Name) and `<Assignments>` (TaskUID, ResourceUID,
  `Units` 1). Import reads the same blocks and falls back to a task's `ResourceNames` when the
  file has no assignments. This fixes the current gap where MSPDI loses the assignee.

### 4.6 What deliberately does not change

- **Scheduling, holds, bookings, conflicts and `replan`.** A person on a task is not a
  constraint until levelling exists. Keep it that way so that assigning someone can never move
  a date or un-accept a double-booking.
- **Summaries**: they may have people, shown as Owner, but those people are **not counted as
  doing work** in any later workload feature. Only leaves count, as with scheduling.

## 5. Impact assessment

| Area | Files | Change | Size | Risk |
|---|---|---|---|---|
| Schema and migration | `server/schema.sql`, `server/db.ts` | Two tables; split `assignee`; drop the column | S | **Medium**: this is a one-way migration of user data. Test it on a `VACUUM INTO` copy of a real database first. |
| Shared rules | `shared/resources.ts` (new), `shared/types.ts` | Parse, key, format, suggest | S | Low |
| Task writes | `server/routes.ts`, `server/plan.ts` | `resources` on create/update/import; `assignee` removed from `TaskFields` and `writeState` | M | Medium: the transaction must include the assignment write, and a resources-only edit must skip `replan`. |
| Resource routes | `server/routes.ts`, `server/resources.ts` (new) | List, rename, merge, delete | S | Low |
| Plan and portfolio payloads | `server/routes.ts` | `resources` and `resource_ids` | S | Low |
| Task table and editor | `Plan.tsx`, `styles.css` | Who column, `ResourceInput`, Show toggle, find box | M | Low |
| Manager dialog | `Dialogs.tsx`, `App.tsx` | Resources dialog | S | Low |
| Gantt | `Gantt.tsx` | Label from the resource list, `+N` | XS | Low |
| Files | `planIO.ts` | CSV column; MSPDI Resources and Assignments | S | Low |
| Seed | `server/seed.ts` | `who: ['Mai', 'Tuan']`; at least one shared task | XS | Low |
| Board, conflicts, holds, schedule, network | — | **None** | — | — |
| Tests | new `tests/resources.test.ts`; fixtures in `schedule`, `taskHolds`, `planIO`, `subTasks` (these set `assignee: null`) | Parse, key and near-match; migration split; merge; CSV and MSPDI round trip; a resources-only update leaves dates and resolutions untouched | M | — |
| Docs | `DESIGN.md` §3 and §16, `CLAUDE.md`, `docs/gantt/user-guide.md`, `data-and-api.md`, `file-formats` | New rules (§6) | S | — |

## 6. Rules to add to `CLAUDE.md` once built

- **Resources are typed as text but stored as rows.** The Who text is only an input and output
  format. `parseResources` and `resourceKey` in `shared/resources.ts` are the only rules for
  splitting and matching names. Never store the joined string.
- **Assigning people is not planning.** `task_resource` is written by the task routes in the
  same transaction as the task, never by `replan`, and it is never read by scheduling. A
  resources-only edit skips `replan`.
- **Resources are global and outlive their tasks.** They are removed only by delete or merge.

## 7. Later features this enables

| Feature | What it adds | Note |
|---|---|---|
| **Workload / over-allocation** | A lane per person, with days counted from `task_resource` over leaf task spans | This is the same shape as environment double-booking, but it **counts working days, not calendar days**: people do not work weekends. Build it as a new count in `shared/`. Do not pass people through `detectConflicts`, which must stay on calendar days. |
| **Allocation %** | `task_resource.units` (100 by default); `Mai[50%]` in the Who column | The syntax is already kept free by refusing `[` (§4.2). |
| **Capacity and time off** | `resource.units`, and a `resource_absence(resource_id, start, end)` table | Same date rules: `YYYY-MM-DD`, UTC. |
| **My tasks / by-person filter** | A filter over `resource_ids`; a portfolio grouped by person | Read-only. |
| **Resource levelling** | Delays tasks to remove over-allocation | Only this feature makes resources a scheduling input. It must go through `replan` in `shared/`, as holds do. |
| **Teams and roles** | `resource.team_id`, `resource.role` | Filters only; the match key stays global. |

## 8. Decisions needed

| Question | Recommendation |
|---|---|
| Resources global or per team? | **Global.** Workload has to see all of a person's work. |
| Keep `task.assignee` as a mirror? | **No.** Migrate, then drop it. |
| Match rule | **Case-insensitive, accents kept.** Catch `Tuan`/`Tuấn` with the near-match suggestion, and fix old duplicates with merge. Folding accents silently could join two real people. |
| Separators | **Comma and semicolon only.** Spaces belong inside names. |
| Delete a person with no tasks automatically? | **No.** Keep them as *unassigned* (R7). |
| Column name in the UI | **Who** in the table, **Resources** for the dialog and files. Use `resource` in the code, because later it can mean a machine or a licence too. |
| Build order | 1) schema, migration and shared rules; 2) task writes and payloads; 3) Who column and editor; 4) Resources dialog; 5) CSV and MSPDI; 6) docs. |

## 9. As built

Everything in §3 is built. Differences from the plan:

- **The plan payload carries every person, not only this plan's.** The Who suggestions need all
  of them, so `resources` on `GET /projects/:id/plan` is the whole list (`listResources`), and
  no second request is needed. The portfolio payload is unchanged, because it does not show names yet.
- **The server takes names, the client sends the Who text.** `resources` on a task write can be
  the text or a list of names; `resourcesFrom` runs both through `parseResources`. Import still
  accepts an old `assignee` field.
- **No Add button in the Resources dialog.** A person is made by typing their name on a task
  (R3), so the dialog only tidies: rename, active, merge (a select, then a `DangerButton`),
  remove. It is in the top bar next to Teams and in the phone's board sheet.
- **Inactive** people keep their tasks but are no longer suggested.
- **The Who column is on by default** and can be switched off under Show. It adds its width to
  the table; column widths fit the plan's text (`client/tableColumns.ts`).
- **An open plan reloads when people are renamed or merged** (`peopleVersion` from `App.tsx`),
  so the names in the table follow at once.
- **The migration is lenient.** An old `assignee` value that breaks the new rules is tidied, not
  lost: brackets are stripped, over-long names are cut to 60 characters.

Tests: `tests/resources.test.ts` covers splitting, the match key, brackets and limits, format
order, suggestions and the near match, the pick, and CSV and MSPDI round trips (including an old
`Assignee` CSV). The migration was checked on a database built from the previous schema with
sample values: names split, case matched, bad values tidied, and a second start is a no-op. The
routes were checked end to end: a people-only edit leaves the plan untouched and is audited,
a rename onto an existing name returns 409, and merge and delete work.

## 10. Overlap warning and the person filter (built 2026-10-01)

The first slice of §7's workload and "my tasks".

- **The rule** is `personOverlaps` in `shared/workload.ts`: two tasks one person is on clash when
  they share at least one **working day** (weekends and holidays skipped), so Friday then Monday
  is fine. Only work counts (`countsAsWork`): leaf tasks with dates, not done, not milestones.
  A summary's people are owners and never clash. It never goes through `detectConflicts`.
- **Across plans.** The plan payload carries `elsewhere`: the open leaf tasks in other projects of
  the people on this plan (`workElsewhere` in `server/queries.ts`). The table runs the rule over
  this plan's scheduled dates plus those, and keeps the pairs that touch this plan.
- **People** in the task toolbar opens **Resource status**: everyone on this plan, the ones on
  overlapping tasks first, each overlap naming both tasks, the shared dates and working days,
  with Show to bring them into view. The button counts the people with an overlap.
- **The Who cell** carries the warning mark (the same ink mark as "should have started") on a
  task whose people are on something else at the same time; it names who and what.
- **The Everyone select** in the toolbar, or **Their tasks** in the panel, shows only the tasks
  one person is on (summaries above them stay, as with Find).
- **No colour.** The warning is a mark, a heavy ink left rule and bold words, like the
  assistant's: red stays spent on double-booked environments.
- Assigning people still never replans; this is read-only.
