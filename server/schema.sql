PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS team (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL UNIQUE,
  code       TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 1,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS environment (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id    INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('SIT','UAT','NFT','PENTEST','PROD','OTHER')),
  capacity   INTEGER NOT NULL DEFAULT 1 CHECK (capacity >= 1),
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE (team_id, name)
);

CREATE TABLE IF NOT EXISTS project (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  team_id       INTEGER NOT NULL REFERENCES team(id) ON DELETE CASCADE,
  parent_id     INTEGER REFERENCES project(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL,
  status        TEXT    NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','in_progress','on_hold','done','cancelled')),
  priority      TEXT    NOT NULL DEFAULT 'normal'
                        CHECK (priority IN ('low','normal','high','critical')),
  owner         TEXT,
  description   TEXT,
  external_link TEXT,
  -- Where the task schedule starts, and the date the project has promised.
  start_date    TEXT,
  target_date   TEXT,
  -- When the task baseline (task_baseline) was last saved; NULL when there is none.
  baseline_at   TEXT
);

CREATE TABLE IF NOT EXISTS booking (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  environment_id INTEGER NOT NULL REFERENCES environment(id) ON DELETE RESTRICT,
  kind           TEXT    NOT NULL DEFAULT 'CUSTOM'
                         CHECK (kind IN ('SIT','UAT','NFT','PENTEST','RELEASE','CUSTOM')),
  start_date     TEXT    NOT NULL,
  end_date       TEXT    NOT NULL,
  confidence     TEXT    NOT NULL DEFAULT 'committed'
                         CHECK (confidence IN ('committed','tentative')),
  optional       INTEGER NOT NULL DEFAULT 0,
  note           TEXT,
  -- Only a CUSTOM booking carries a marker; the API clears it for every other kind.
  marker         TEXT    CHECK (marker IN ('star','flag','pin')),
  -- What the bar says, when someone wrote it. NULL means project name then note.
  timeline_text  TEXT,
  -- start_date/end_date are the EFFECTIVE span: the manual one stretched over any
  -- task hold (shared/taskHolds.ts). NULL manual dates mean the tasks made it.
  manual_start   TEXT,
  manual_end     TEXT,
  -- The task hold this booking covers, written by replan; NULL when none.
  hold_start     TEXT,
  hold_end       TEXT,
  hold_done      INTEGER NOT NULL DEFAULT 0,
  CHECK (end_date >= start_date)
);

-- Conflict detection is a range-overlap scan per environment; this is its hot path.
CREATE INDEX IF NOT EXISTS idx_booking_env_range ON booking(environment_id, start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_booking_project   ON booking(project_id);
CREATE INDEX IF NOT EXISTS idx_project_team      ON project(team_id);
CREATE INDEX IF NOT EXISTS idx_env_team          ON environment(team_id);

-- A double-booking someone has looked at and accepted. Keyed by environment and the
-- exact set of clashing bookings (see conflictKey in shared/conflicts.ts), so the
-- alarm returns when a new booking joins the clash.
CREATE TABLE IF NOT EXISTS conflict_resolution (
  key            TEXT    PRIMARY KEY,
  environment_id INTEGER NOT NULL REFERENCES environment(id) ON DELETE CASCADE,
  resolved_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_resolution_env ON conflict_resolution(environment_id);

-- Work a project has to do. Dates are scheduled by server/plan.ts from duration and
-- dependencies (shared/schedule.ts), never typed. A task on an environment books it.
CREATE TABLE IF NOT EXISTS task (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id     INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  environment_id INTEGER REFERENCES environment(id) ON DELETE RESTRICT,
  name           TEXT    NOT NULL,
  duration       INTEGER NOT NULL DEFAULT 1 CHECK (duration >= 0),
  status         TEXT    NOT NULL DEFAULT 'todo'
                         CHECK (status IN ('todo','in_progress','blocked','done')),
  not_before     TEXT,
  assignee       TEXT,
  note           TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0,
  actual_start   TEXT,
  actual_end     TEXT,
  start_date     TEXT,
  end_date       TEXT,
  total_float    INTEGER,
  critical       INTEGER NOT NULL DEFAULT 0,
  -- Where someone dragged the task's box in the network diagram. Layout only:
  -- NULL means the automatic place. Never read by scheduling.
  net_x          REAL,
  net_y          REAL,
  -- The summary task this one sits under (shared/wbs.ts). A task with children is
  -- a summary: dates roll up, it books nothing. Deleting a summary lifts its
  -- children a level (server/plan.ts), so SET NULL is only a safety net.
  parent_id      INTEGER REFERENCES task(id) ON DELETE SET NULL,
  -- Percent complete as typed; NULL means work it out from status. Not scheduling.
  progress       INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100),
  -- The task's ID as people write it, in After and in files: a whole number,
  -- unique in its project (index in server/db.ts), typed or given the next free
  -- one. Links are stored by `id`, so renumbering never breaks one.
  code           INTEGER CHECK (code IS NULL OR code > 0)
);

CREATE INDEX IF NOT EXISTS idx_task_project ON task(project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_task_env     ON task(environment_id);

-- A link within one project: FS (finish-to-start), SS or FF. Lag in working days;
-- negative is a lead. Links to or from a summary task are FS only.
CREATE TABLE IF NOT EXISTS task_dependency (
  predecessor_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  successor_id   INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  lag            INTEGER NOT NULL DEFAULT 0,
  type           TEXT    NOT NULL DEFAULT 'FS' CHECK (type IN ('FS','SS','FF')),
  -- A hand-shaped arrow in the network diagram (see routeOf in client/network.ts):
  -- first vertical run from the source's edge, detour height, last vertical run
  -- before the target. NULL means automatic. Layout only.
  route_out      REAL,
  route_y        REAL,
  route_in       REAL,
  -- Which anchor the arrow leaves and reaches a box by: 'top', 'mid' or 'bottom'
  -- on the box's side. NULL is the automatic port. Layout only.
  route_from     TEXT,
  route_to       TEXT,
  PRIMARY KEY (predecessor_id, successor_id),
  CHECK (predecessor_id <> successor_id)
);

CREATE INDEX IF NOT EXISTS idx_dep_successor ON task_dependency(successor_id);

-- A project's saved baseline: each task's dates when someone last said "this is
-- the plan". A snapshot for comparison only; scheduling never reads it.
CREATE TABLE IF NOT EXISTS task_baseline (
  task_id    INTEGER PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  project_id INTEGER NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  start_date TEXT    NOT NULL,
  end_date   TEXT    NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_baseline_project ON task_baseline(project_id);

CREATE TABLE IF NOT EXISTS holiday (
  date TEXT PRIMARY KEY,
  name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  entity    TEXT NOT NULL,
  entity_id INTEGER NOT NULL,
  field     TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  actor     TEXT NOT NULL DEFAULT 'local',
  at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id, at DESC);
