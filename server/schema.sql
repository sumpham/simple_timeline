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
  external_link TEXT
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
