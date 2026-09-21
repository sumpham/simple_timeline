import { all } from './db.ts';
import { calendarDays, workingDays } from '../shared/dates.ts';
import type { BookingView, Environment, Holiday, ISODate, Project, Team } from '../shared/types.ts';

type RawBooking = Omit<BookingView, 'calendar_days' | 'working_days' | 'is_milestone'>;

export function holidaySet(): Set<ISODate> {
  return new Set(all<Holiday>('SELECT date, name FROM holiday').map((h) => h.date));
}

/** Teams carry the counts a delete confirmation needs to be honest. */
export function listTeams(): Team[] {
  return all<Team>(
    `SELECT t.*,
            (SELECT COUNT(*) FROM project p WHERE p.team_id = t.id) AS project_count,
            (SELECT COUNT(*) FROM booking b
               JOIN project p ON p.id = b.project_id
              WHERE p.team_id = t.id) AS booking_count
       FROM team t
      ORDER BY t.active DESC, t.name`,
  );
}

export function listEnvironments(teamId?: number): Environment[] {
  const where = teamId == null ? '' : 'WHERE e.team_id = ?';
  const params = teamId == null ? [] : [teamId];
  return all<Environment>(
    `SELECT e.*,
            (SELECT COUNT(*) FROM booking b WHERE b.environment_id = e.id) AS booking_count
       FROM environment e
       ${where}
      ORDER BY e.team_id, e.sort_order, e.name`,
    ...params,
  );
}

/** Projects with their total booking count, window-independent. */
export function listProjects(teamId?: number): Project[] {
  const where = teamId == null ? '' : 'WHERE p.team_id = ?';
  const params = teamId == null ? [] : [teamId];
  return all<Project>(
    `SELECT p.*,
            (SELECT COUNT(*) FROM booking b WHERE b.project_id = p.id) AS booking_count
       FROM project p
       ${where}
      ORDER BY p.name`,
    ...params,
  );
}

export function listHolidays(): Holiday[] {
  return all<Holiday>('SELECT date, name FROM holiday ORDER BY date');
}

/**
 * Bookings enriched with the project/environment facts the board and the conflict
 * engine both need, so neither has to join anything at render time.
 */
export function listBookings(filter: {
  teamId?: number;
  envIds?: number[];
  from?: ISODate;
  to?: ISODate;
} = {}): BookingView[] {
  const where: string[] = [];
  const params: unknown[] = [];

  if (filter.teamId != null) {
    where.push('p.team_id = ?');
    params.push(filter.teamId);
  }
  if (filter.envIds?.length) {
    where.push(`b.environment_id IN (${filter.envIds.map(() => '?').join(',')})`);
    params.push(...filter.envIds);
  }
  // Overlap, not containment: a booking straddling the window edge must still appear.
  if (filter.from) {
    where.push('b.end_date >= ?');
    params.push(filter.from);
  }
  if (filter.to) {
    where.push('b.start_date <= ?');
    params.push(filter.to);
  }

  const rows = all<RawBooking>(
    `SELECT b.*,
            p.name     AS project_name,
            p.team_id  AS team_id,
            p.priority AS priority,
            e.name     AS env_name,
            e.kind     AS env_kind,
            e.capacity AS capacity
       FROM booking b
       JOIN project p     ON p.id = b.project_id
       JOIN environment e ON e.id = b.environment_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY b.start_date, b.id`,
    ...params,
  );

  const holidays = holidaySet();
  return rows.map((r) => ({
    ...r,
    calendar_days: calendarDays(r.start_date, r.end_date),
    working_days: workingDays(r.start_date, r.end_date, holidays),
    // A release is a moment, not a span, and the renderer draws it as a diamond.
    is_milestone: r.kind === 'RELEASE' || r.start_date === r.end_date,
  }));
}
