# Timeline for project management tools

## 1. Context

I'm a project technical lead and want a tool to view the plan timeline for all teams.
Each team has multiple projects, each project may have sub-projects, and work flows
through multiple environments (SIT, UAT, PROD, NFT, …).

With this tool I want to:

- See an overview of timelines across all teams.
- Drill into one environment of one project of one team.
- **Detect conflicts** — spot where two projects want the same environment at the same time.

Conflict detection is the reason this tool exists. Everything else is supporting scaffolding.

## 2. Personas

| Persona | Needs | Primary view |
|---|---|---|
| **Technical lead** (me) | Cross-team overview, conflict detection, resolution | Portfolio timeline |
| **Project manager** | Maintain one project's dates, see who blocks them | Team timeline |
| **Team member / stakeholder** | Read-only "when is UAT?" | Shared read-only link |
| **QA / environment owner** | Who owns SIT next week? | Environment swimlane view |

## 3. Domain model

```
Organization
└── Team (1..n)
    ├── Environment (1..n)      — scoped to the team, e.g. SIT, UAT, PROD, NFT
    └── Project (1..n)
        ├── Sub-project (0..n)  — same shape as Project, one level of nesting
        └── Phase (1..n)        — a dated booking of one environment
```

### 3.1 Entities

**Team**
- `name` (required, unique within org), `code` (short label for dense timeline rows)
- `color` (drives timeline bar color), `description`, `active` flag

**Environment**
- Belongs to exactly one team. `name`, `kind` (enum: `SIT | UAT | PROD | NFT | PENTEST | OTHER`)
- `capacity` — how many projects may occupy it simultaneously. Default `1`.
  This is the knob that makes conflict detection meaningful; some teams genuinely have
  two parallel SIT slots, and hardcoding `1` would produce false positives.
- `shared` flag — if true, the environment is visible/bookable across teams (e.g. a shared PROD).

**Project**
- `name` (required), `team` (required), `parent` (nullable → makes it a sub-project)
- `status`: `planned | in_progress | on_hold | done | cancelled`
- `priority`: `low | normal | high | critical` — used to rank conflicts, not just decorate
- `owner`, `description`, `tags[]`, `external_link` (Jira/Confluence)

**Phase** (the actual timeline bar)
- `project`, `environment`, `kind` (`SIT | UAT | RELEASE | NFT | PENTEST | CUSTOM`)
- `start_date`, `end_date` — a **Release date** is a milestone, stored as a zero-length
  phase (`start == end`) so that one rendering path handles both bars and diamonds.
- `optional` flag (SIT, NFT, Pentest are optional per the original brief; UAT and Release are not)
- `confidence`: `committed | tentative` — tentative phases are rendered hatched and can be
  excluded from conflict checks, which keeps early-stage planning from spamming warnings.

### 3.2 Derived rules

- A project's overall span = min(start) to max(end) across its phases, including sub-projects.
- A parent project's bar is a roll-up; collapsing it shows the roll-up, expanding shows children.
- Default phase ordering for validation: SIT → UAT → NFT/Pentest → Release. Out-of-order dates
  are a warning, not an error — real plans break this.

## 4. Functional requirements

### 4.1 Team management
- Create, rename, archive a team. Archived teams hide from views but retain history.
- Assign a color per team; reuse it consistently in every view.

### 4.2 Environment management
- Add/edit/remove environments on a team. Removal is blocked while phases reference it.
- Set `capacity` and `shared`.
- Seed new teams with SIT, UAT, PROD by default so the empty state isn't a blank wall.

### 4.3 Project management
- Create a project under a team; optionally nest under a parent project (one level).
- Edit phases inline: pick environment, kind, dates, confidence.
- **Duplicate project** — most projects in a team share a phase shape; cloning beats retyping.
- Bulk shift: move an entire project's dates by ±N days when a release slips.

### 4.4 Timeline visualization (the core)

Gantt-style, modeled on Jira Plans / Linear / Monday timeline views:

- **Rows**: grouped by team → project → sub-project, collapsible at each level.
- **Columns**: a zoomable time axis — Day / Week / Month / Quarter. Month is the default.
- **Bars**: one per phase, colored by environment kind, labeled with the phase name when it fits.
  Milestones (Release) render as diamonds.
- **Today marker**: a vertical line, always visible.
- **Interactions**: drag to move a bar, drag an edge to resize, click to open a detail panel.
  Every drag re-runs conflict detection live and highlights new collisions immediately.
- **Horizontal scroll + sticky left rail** of row labels.
- **Dependency arrows** (phase A must finish before phase B starts) — see §8, post-MVP.

### 4.5 Environment filter & conflict detection

- Multi-select environments; the timeline shows only projects touching the selection.
- Alternate **swimlane mode**: one row *per environment*, with every project competing for it
  stacked inside. This is the view that makes overlaps obvious — overlapping bars in the same
  lane are literally stacked on top of each other.
- A **conflict** = for a given environment, the number of overlapping `committed` phases at any
  point in time exceeds that environment's `capacity`.
- Conflicts are surfaced three ways:
  1. Red hatching on the overlapping date range in the timeline.
  2. A conflict count badge in the toolbar.
  3. A conflict list panel — sorted by severity (overlap days × max priority of involved projects),
     each row naming the environment, the date range, and the colliding projects.
- Filter toggle: "show conflicts only" collapses the timeline to just the offending rows.
- Conflicts can be **acknowledged** with a note ("agreed with team B, they go first"), which mutes
  the warning without deleting it. Without this, a known-and-accepted overlap nags forever and
  people start ignoring all warnings.

### 4.6 Views and sharing
- Saved views: a named combination of team filter, environment filter, date range, zoom.
- Read-only share link for stakeholders.
- Export: PNG/PDF of the current timeline, CSV of phases.

## 5. Non-functional requirements

- **Scale target**: 20 teams × 30 projects × 5 phases ≈ 3,000 bars. The timeline must stay
  smooth at that size — virtualize rows and only render bars in the visible date window.
- **Responsive**: usable at laptop width; tablet read-only is acceptable. Phone is out of scope
  for the Gantt itself (offer the conflict list instead).
- **Accessibility**: never encode conflict state in color alone — pair red with hatching and an
  icon. Full keyboard navigation of rows and bars.
- **Timezone**: all dates are date-only (no times). Store as `DATE`, not timestamps — this avoids
  the classic off-by-one where a release "moves" depending on the viewer's timezone.
- **Audit**: record who changed which dates and when; date changes are the thing people argue about.

## 6. Data model sketch

```sql
team(id, name, code, color, active, created_at)
environment(id, team_id, name, kind, capacity, shared)
project(id, team_id, parent_id, name, status, priority, owner, description, external_link)
phase(id, project_id, environment_id, kind, start_date, end_date, optional, confidence)
conflict_ack(id, environment_id, range_start, range_end, project_ids[], note, acked_by, acked_at)
audit_log(id, entity, entity_id, field, old_value, new_value, actor, at)
```

Index `phase(environment_id, start_date, end_date)` — conflict detection is a range-overlap query
and this is the hot path.

## 7. API sketch

```
GET  /api/teams
GET  /api/timeline?teams=&environments=&from=&to=   → rows + bars, pre-grouped for rendering
GET  /api/conflicts?environments=&from=&to=         → detected conflicts + ack status
POST /api/projects            PATCH /api/projects/:id
POST /api/phases              PATCH /api/phases/:id   DELETE /api/phases/:id
POST /api/projects/:id/shift  { days: -7 }
POST /api/conflicts/ack
```

`/api/timeline` returning render-ready rows (rather than raw entities the client must join)
keeps the drag-heavy UI from doing N+1 work on every interaction.

## 8. Scope phasing

**MVP** — teams, environments, projects (flat), phases, month/week Gantt, environment
multi-select filter, overlap detection with a conflict list.

**V2** — sub-projects and roll-up bars, drag-to-edit, swimlane mode, conflict acknowledgement,
saved views, bulk shift.

**V3** — dependency arrows and critical path, capacity/resource view, export to PNG/PDF,
Jira import, notifications when someone's change creates a conflict with your project.

**Explicitly out of scope** — task-level tracking, time logging, budgets, sprint boards.
This is a portfolio-level timeline, not a replacement for Jira.

## 9. Tech requirements

- Web application.
- Stack not yet chosen. The one hard constraint: the Gantt is the product, so either use a
  mature timeline library or budget real time for a custom canvas/SVG renderer — a naive
  DOM-per-bar implementation will not hold up at the scale in §5.

## 10. Open questions

1. **Authentication** — is this single-user (just me), or multi-user with per-team edit rights?
   This changes the data model and roughly a third of the build.
   => No authen for now
2. **Capacity default** — is one project per environment at a time the right default, or do your
   teams routinely run parallel SIT?
   => One working team has its environments e.g SIT, UAT,... and this team can work with multi projects (share one set of environment of team)
3. **Cross-team shared environments** — does a shared PROD exist that teams compete for? If so,
   conflict detection must span teams, not just work within one.
   => No cross team share environment,
4. **Source of truth** — will dates be entered here, or imported from Jira/Excel? Import changes
   the priority of the editing UI considerably.
   => No import
5. **Sub-project nesting depth** — is one level enough, or do you need arbitrary depth?
=> One level is enough
6. **Working days** — should durations skip weekends and holidays?
=> Yes
