import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inOutlineOrder } from '../shared/wbs.ts';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

export const DB_PATH = process.env.TIMELINE_DB ?? join(root, 'data', 'timeline.db');

export const db = new DatabaseSync(DB_PATH);

db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));

// schema.sql only creates missing tables, so columns added later are backfilled
// here for databases made before them.
const bookingColumns = new Set(
  db.prepare('PRAGMA table_info(booking)').all().map((c) => (c as { name: string }).name),
);
if (!bookingColumns.has('note')) db.exec('ALTER TABLE booking ADD COLUMN note TEXT');
if (!bookingColumns.has('timeline_text')) db.exec('ALTER TABLE booking ADD COLUMN timeline_text TEXT');
if (!bookingColumns.has('marker')) {
  db.exec("ALTER TABLE booking ADD COLUMN marker TEXT CHECK (marker IN ('star','flag','pin'))");
}
if (!bookingColumns.has('manual_start')) {
  db.exec('ALTER TABLE booking ADD COLUMN manual_start TEXT');
  db.exec('ALTER TABLE booking ADD COLUMN manual_end TEXT');
  // Every booking made before tasks existed was made by hand.
  db.exec('UPDATE booking SET manual_start = start_date, manual_end = end_date');
}
if (!bookingColumns.has('hold_start')) {
  db.exec('ALTER TABLE booking ADD COLUMN hold_start TEXT');
  db.exec('ALTER TABLE booking ADD COLUMN hold_end TEXT');
  db.exec('ALTER TABLE booking ADD COLUMN hold_done INTEGER NOT NULL DEFAULT 0');
}

const taskColumns = new Set(
  db.prepare('PRAGMA table_info(task)').all().map((c) => (c as { name: string }).name),
);
if (!taskColumns.has('net_x')) {
  db.exec('ALTER TABLE task ADD COLUMN net_x REAL');
  db.exec('ALTER TABLE task ADD COLUMN net_y REAL');
}
if (!taskColumns.has('parent_id')) {
  db.exec('ALTER TABLE task ADD COLUMN parent_id INTEGER REFERENCES task(id) ON DELETE SET NULL');
  db.exec('ALTER TABLE task ADD COLUMN progress INTEGER CHECK (progress IS NULL OR progress BETWEEN 0 AND 100)');
}
if (!taskColumns.has('code')) {
  db.exec('ALTER TABLE task ADD COLUMN code INTEGER CHECK (code IS NULL OR code > 0)');
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS task_code ON task (project_id, code)');
const depColumns = new Set(
  db.prepare('PRAGMA table_info(task_dependency)').all().map((c) => (c as { name: string }).name),
);
if (!depColumns.has('route_out')) {
  db.exec('ALTER TABLE task_dependency ADD COLUMN route_out REAL');
  db.exec('ALTER TABLE task_dependency ADD COLUMN route_y REAL');
  db.exec('ALTER TABLE task_dependency ADD COLUMN route_in REAL');
}
if (!depColumns.has('type')) {
  db.exec("ALTER TABLE task_dependency ADD COLUMN type TEXT NOT NULL DEFAULT 'FS' CHECK (type IN ('FS','SS','FF'))");
}
if (!depColumns.has('route_from')) {
  db.exec('ALTER TABLE task_dependency ADD COLUMN route_from TEXT');
  db.exec('ALTER TABLE task_dependency ADD COLUMN route_to TEXT');
}

const projectColumns = new Set(
  db.prepare('PRAGMA table_info(project)').all().map((c) => (c as { name: string }).name),
);
if (!projectColumns.has('start_date')) db.exec('ALTER TABLE project ADD COLUMN start_date TEXT');
if (!projectColumns.has('target_date')) db.exec('ALTER TABLE project ADD COLUMN target_date TEXT');
if (!projectColumns.has('baseline_at')) db.exec('ALTER TABLE project ADD COLUMN baseline_at TEXT');

// One-day bookings are CUSTOM events (see shared/bookings.ts); bring older
// rows into line. Idempotent, so it is safe on every start.
db.exec(`UPDATE booking SET kind = 'CUSTOM' WHERE start_date = end_date AND kind NOT IN ('RELEASE', 'CUSTOM')`);

/**
 * Give every task without a TaskID one: tasks made before IDs existed keep their
 * row number, so After reads the same as it did; others get the next free one.
 * Idempotent, so it runs on every start (and after the seed).
 */
export function fillTaskCodes() {
  const projects = db.prepare('SELECT DISTINCT project_id AS id FROM task WHERE code IS NULL').all() as { id: number }[];
  for (const { id } of projects) {
    const tasks = inOutlineOrder(db.prepare('SELECT id, sort_order, parent_id, code FROM task WHERE project_id = ?').all(id)
      .map((r) => ({ ...r }) as { id: number; sort_order: number; parent_id: number | null; code: number | null }));
    const used = new Set(tasks.map((t) => t.code).filter((c) => c != null));
    tasks.forEach((t, i) => {
      if (t.code != null) return;
      let code = i + 1;
      while (used.has(code)) code++;
      used.add(code);
      db.prepare('UPDATE task SET code = ? WHERE id = ?').run(code, t.id);
    });
  }
}
fillTaskCodes();

/** node:sqlite returns null-prototype rows; spread them so JSON and spread operators behave. */
export function all<T>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])).map((r) => ({ ...r })) as T[];
}

export function get<T>(sql: string, ...params: unknown[]): T | undefined {
  const row = db.prepare(sql).get(...(params as never[]));
  return row ? ({ ...row } as T) : undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return db.prepare(sql).run(...(params as never[]));
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function audit(entity: string, entityId: number, field: string, oldValue: unknown, newValue: unknown) {
  run(
    'INSERT INTO audit_log (entity, entity_id, field, old_value, new_value) VALUES (?, ?, ?, ?, ?)',
    entity, entityId, field,
    oldValue === null || oldValue === undefined ? null : String(oldValue),
    newValue === null || newValue === undefined ? null : String(newValue),
  );
}
