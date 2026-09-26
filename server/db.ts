import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// One-day bookings are CUSTOM events (see shared/bookings.ts); bring older
// rows into line. Idempotent, so it is safe on every start.
db.exec(`UPDATE booking SET kind = 'CUSTOM' WHERE start_date = end_date AND kind NOT IN ('RELEASE', 'CUSTOM')`);

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
