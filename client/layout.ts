import { addDays, addMonths, diffDays, startOfMonth, startOfQuarter, startOfWeek, toUTC } from '../shared/dates.ts';
import type { BookingView, Conflict, ISODate } from '../shared/types.ts';

export type Zoom = 'week' | 'month' | 'quarter';

/** Pixels per calendar day, and how much history/future each zoom shows. */
export const ZOOM: Record<Zoom, { dayWidth: number; backDays: number; forwardDays: number; label: string }> = {
  week:    { dayWidth: 34, backDays: 14, forwardDays: 56,  label: 'Week' },
  month:   { dayWidth: 11, backDays: 21, forwardDays: 160, label: 'Month' },
  quarter: { dayWidth: 4,  backDays: 45, forwardDays: 320, label: 'Quarter' },
};

export type Scale = {
  zoom: Zoom;
  dayWidth: number;
  from: ISODate;
  to: ISODate;
  totalDays: number;
  width: number;
  x: (date: ISODate) => number;
  spanWidth: (start: ISODate, end: ISODate) => number;
};

export function makeScale(zoom: Zoom, anchor: ISODate): Scale {
  const { dayWidth, backDays, forwardDays } = ZOOM[zoom];
  // Anchoring the window to a Monday lets the weekend shading be a repeating
  // gradient rather than hundreds of positioned elements.
  const from = startOfWeek(addDays(anchor, -backDays));
  const to = addDays(from, backDays + forwardDays);
  const totalDays = diffDays(from, to) + 1;

  return {
    zoom,
    dayWidth,
    from,
    to,
    totalDays,
    width: totalDays * dayWidth,
    x: (date) => diffDays(from, date) * dayWidth,
    spanWidth: (start, end) => Math.max(dayWidth, (diffDays(start, end) + 1) * dayWidth),
  };
}

export type Tick = { date: ISODate; label: string; major: boolean };

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** The upper ruler band: months, or quarters when zoomed out. */
export function majorTicks(scale: Scale): Tick[] {
  const stepMonths = scale.zoom === 'quarter' ? 3 : 1;
  const align = scale.zoom === 'quarter' ? startOfQuarter : startOfMonth;

  const ticks: Tick[] = [];
  // Walk period starts and step by the period's own length. Advancing by one
  // month and re-aligning would snap a quarter back to where it began, and the
  // loop would never terminate.
  let period = align(scale.from);

  // A ruler can never legitimately need this many bands; the bound means a
  // future mistake here shows up as a short ruler, not a frozen tab.
  for (let guard = 0; guard < 600 && toUTC(period) <= toUTC(scale.to); guard++) {
    // A period that began before the window is labelled at the window edge.
    const at = toUTC(period) < toUTC(scale.from) ? scale.from : period;
    ticks.push({ date: at, label: periodLabel(period, scale.zoom), major: true });
    period = addMonths(period, stepMonths);
  }

  // The window rarely starts on a period boundary, so the clamped first tick can
  // land on top of the real one. Drop it rather than overprint two labels.
  if (ticks.length > 1) {
    const gap = diffDays(ticks[0].date, ticks[1].date) * scale.dayWidth;
    if (gap < 46) ticks.shift();
  }
  return ticks;
}

function periodLabel(periodStart: ISODate, zoom: Zoom): string {
  const month = Number(periodStart.slice(5, 7));
  const year = periodStart.slice(0, 4);
  if (zoom === 'quarter') return `Q${Math.floor((month - 1) / 3) + 1} ${year}`;
  return `${MONTHS[month - 1]}${month === 1 ? ` ${year}` : ''}`;
}

/** The lower ruler band: days when close in, week-commencing dates when not. */
export function minorTicks(scale: Scale): Tick[] {
  const ticks: Tick[] = [];
  if (scale.zoom === 'quarter') return ticks;

  const stepDays = scale.zoom === 'week' ? 1 : 7;
  let cur = scale.zoom === 'week' ? scale.from : startOfWeek(scale.from);

  while (toUTC(cur) <= toUTC(scale.to)) {
    ticks.push({
      date: cur,
      label: scale.zoom === 'week' ? cur.slice(8, 10) : `${Number(cur.slice(8, 10))} ${MONTHS[Number(cur.slice(5, 7)) - 1]}`,
      major: false,
    });
    cur = addDays(cur, stepDays);
  }
  return ticks;
}

/**
 * Greedy interval packing: assign each booking the topmost sub-lane it fits in.
 * Overlapping bookings therefore stack, which is what makes a double-booking
 * visible as a physical pile rather than a colour.
 *
 * `dayWidth` lets a milestone reserve the horizontal room its label needs. A
 * release is zero days wide but its text is not, and two releases a few days
 * apart would otherwise print on top of each other.
 */
export function packLanes(
  bookings: readonly BookingView[],
  dayWidth = 0,
): { booking: BookingView; lane: number }[] {
  const sorted = [...bookings].sort(
    (a, b) => a.start_date.localeCompare(b.start_date) || b.calendar_days - a.calendar_days,
  );
  const laneEnds: string[] = [];
  const placed: { booking: BookingView; lane: number }[] = [];

  for (const booking of sorted) {
    const reserved = reservedEnd(booking, dayWidth);
    let lane = laneEnds.findIndex((end) => end < booking.start_date);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(reserved);
    } else {
      laneEnds[lane] = reserved;
    }
    placed.push({ booking, lane });
  }
  return placed;
}

/** Diamond plus gap plus label, converted from pixels into days at this zoom. */
function reservedEnd(booking: BookingView, dayWidth: number): ISODate {
  if (!booking.is_milestone || dayWidth <= 0) return booking.end_date;
  const labelPx = 24 + booking.project_name.length * 5.4;
  return addDays(booking.end_date, Math.ceil(labelPx / dayWidth));
}

export function laneCount(placed: readonly { lane: number }[]): number {
  return placed.reduce((max, p) => Math.max(max, p.lane + 1), 1);
}

/** Conflicts that touch a given environment, for painting that lane. */
export function conflictsForEnvironment(conflicts: readonly Conflict[], environmentId: number): Conflict[] {
  return conflicts.filter((c) => c.environment_id === environmentId);
}

const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function formatDate(d: ISODate): string {
  return `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
}

export function formatLongDate(d: ISODate): string {
  return `${Number(d.slice(8, 10))} ${FULL_MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
}

export function formatRange(start: ISODate, end: ISODate): string {
  return start === end ? formatDate(start) : `${formatDate(start)} – ${formatDate(end)}`;
}

/** "in 4 days" / "4 days ago", for the occupancy strip. */
export function relativeDays(from: ISODate, to: ISODate): string {
  const n = diffDays(from, to);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${Math.abs(n)} days ago`;
}
