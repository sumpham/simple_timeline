import { addDays, diffDays, overlapDays, toUTC } from './dates.ts';
import { PRIORITY_RANK, type BookingView, type Conflict, type ISODate, type Priority } from './types.ts';

/**
 * Double-booking detection.
 *
 * A conflict is a stretch of time where an environment holds more concurrent
 * bookings than its capacity allows. Detection runs on CALENDAR days, not
 * working days: a booking that spans a weekend still holds the environment
 * through it, so freeing Sat/Sun would report overlaps that do not exist.
 *
 * Sweep line over each environment's bookings: O(n log n) in the number of
 * bookings, which keeps the drag-preview path in V2 cheap enough to run on
 * every pointer move.
 */

type Edge = { at: number; delta: 1 | -1; booking: BookingView };

/** Tentative bookings are excluded by default so early planning does not cry wolf. */
export type ConflictOptions = {
  includeTentative?: boolean;
};

export function detectConflicts(
  bookings: readonly BookingView[],
  options: ConflictOptions = {},
): Conflict[] {
  const { includeTentative = false } = options;

  const considered = bookings.filter((b) => {
    if (!includeTentative && b.confidence !== 'committed') return false;
    // Milestones are moments, not occupancy. A release date does not hold an
    // environment, so it cannot double-book one.
    if (b.is_milestone) return false;
    return diffDays(b.start_date, b.end_date) >= 0;
  });

  const byEnv = new Map<number, BookingView[]>();
  for (const b of considered) {
    const list = byEnv.get(b.environment_id);
    if (list) list.push(b);
    else byEnv.set(b.environment_id, [b]);
  }

  const conflicts: Conflict[] = [];
  for (const [envId, envBookings] of byEnv) {
    conflicts.push(...sweepEnvironment(envId, envBookings));
  }

  return conflicts.sort((a, b) => b.severity - a.severity || a.start_date.localeCompare(b.start_date));
}

function sweepEnvironment(environmentId: number, bookings: BookingView[]): Conflict[] {
  const capacity = Math.max(1, bookings[0]?.capacity ?? 1);
  if (bookings.length <= capacity) return [];

  // End edges are placed on the day AFTER the last occupied day, so that a
  // booking ending Mar 3 and one starting Mar 4 do not register as overlapping,
  // while two both live on Mar 3 do.
  const edges: Edge[] = [];
  for (const b of bookings) {
    edges.push({ at: toUTC(b.start_date), delta: 1, booking: b });
    edges.push({ at: toUTC(addDays(b.end_date, 1)), delta: -1, booking: b });
  }
  // Process departures before arrivals at the same instant.
  edges.sort((a, b) => a.at - b.at || a.delta - b.delta);

  const active = new Set<BookingView>();
  const conflicts: Conflict[] = [];
  let open: { start: number; peak: number; involved: Set<BookingView> } | null = null;

  for (let i = 0; i < edges.length; i++) {
    const edge = edges[i];

    if (edge.delta === 1) active.add(edge.booking);
    else active.delete(edge.booking);

    // Collapse simultaneous edges: only evaluate once the instant is fully applied.
    if (i + 1 < edges.length && edges[i + 1].at === edge.at) continue;

    const overCapacity = active.size > capacity;

    if (overCapacity && !open) {
      open = { start: edge.at, peak: active.size, involved: new Set(active) };
    } else if (overCapacity && open) {
      open.peak = Math.max(open.peak, active.size);
      for (const b of active) open.involved.add(b);
    } else if (!overCapacity && open) {
      conflicts.push(buildConflict(environmentId, capacity, open, edge.at));
      open = null;
    }
  }

  return conflicts;
}

function buildConflict(
  environmentId: number,
  capacity: number,
  open: { start: number; peak: number; involved: Set<BookingView> },
  endExclusive: number,
): Conflict {
  const start = isoFromMs(open.start);
  // endExclusive is the first free day, so the last occupied day is the one before.
  const end = addDays(isoFromMs(endExclusive), -1);
  const involved = [...open.involved].filter((b) => overlapDays(b.start_date, b.end_date, start, end) > 0);

  const projects = dedupeProjects(involved);
  const topRank = projects.reduce((max, p) => Math.max(max, PRIORITY_RANK[p.priority]), 1);
  const days = diffDays(start, end) + 1;
  const first = involved[0];

  return {
    environment_id: environmentId,
    env_name: first?.env_name ?? '',
    env_kind: first?.env_kind ?? 'OTHER',
    capacity,
    start_date: start,
    end_date: end,
    peak: open.peak,
    booking_ids: involved.map((b) => b.id).sort((a, b) => a - b),
    projects,
    overlap_days: days,
    severity: days * topRank,
  };
}

function dedupeProjects(bookings: BookingView[]): { id: number; name: string; priority: Priority }[] {
  const seen = new Map<number, { id: number; name: string; priority: Priority }>();
  for (const b of bookings) {
    if (!seen.has(b.project_id)) {
      seen.set(b.project_id, { id: b.project_id, name: b.project_name, priority: b.priority });
    }
  }
  return [...seen.values()].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
}

function isoFromMs(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Booking ids touched by any conflict, for painting the board. */
export function conflictedBookingIds(conflicts: readonly Conflict[]): Set<number> {
  const ids = new Set<number>();
  for (const c of conflicts) for (const id of c.booking_ids) ids.add(id);
  return ids;
}

/**
 * Live occupancy of one environment on a given day: which bookings hold it.
 * Drives the lane's `booked/capacity` readout and the today strip.
 */
export function occupancyOn(
  bookings: readonly BookingView[],
  environmentId: number,
  day: ISODate,
): BookingView[] {
  return bookings.filter(
    (b) =>
      b.environment_id === environmentId &&
      !b.is_milestone &&
      overlapDays(b.start_date, b.end_date, day, day) > 0,
  );
}

/** The next booking to start strictly after `day`, for "next: Billing, Mar 3". */
export function nextBookingAfter(
  bookings: readonly BookingView[],
  environmentId: number,
  day: ISODate,
): BookingView | null {
  const upcoming = bookings
    .filter((b) => b.environment_id === environmentId && !b.is_milestone && diffDays(day, b.start_date) > 0)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
  return upcoming[0] ?? null;
}

/**
 * A double-booking's identity for resolution: its environment and exactly which
 * bookings clash. Dates are left out on purpose, so nudging a booking that is
 * already accepted keeps it accepted; a new booking joining the clash makes a new
 * key, and the alarm comes back, because that is a clash nobody has looked at.
 */
export function conflictKey(c: Pick<Conflict, 'environment_id' | 'booking_ids'>): string {
  return `${c.environment_id}:${[...c.booking_ids].sort((a, b) => a - b).join(',')}`;
}

/**
 * Stamp each conflict with whether it has been resolved. Resolved ones sort after
 * the rest, so the list still opens on the clashes that need someone.
 */
export function applyResolutions(conflicts: readonly Conflict[], resolved: ReadonlySet<string>): Conflict[] {
  return conflicts
    .map((c) => ({ ...c, resolved: resolved.has(conflictKey(c)) }))
    .sort((a, b) => Number(a.resolved) - Number(b.resolved));
}

/** The conflicts that still raise the alarm. */
export function openConflicts(conflicts: readonly Conflict[]): Conflict[] {
  return conflicts.filter((c) => !c.resolved);
}
