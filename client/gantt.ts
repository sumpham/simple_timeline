import { leavesOf, summaryIds } from '../shared/wbs.ts';
import type { ISODate, Task, TaskDependency } from '../shared/types.ts';
import type { TaskInput } from './api.ts';
import {
  addDays, dayOfWeek, diffDays, maxDate, minDate, snapToWorkingDay, startOfWeek, workingDays, type HolidaySet,
} from '../shared/dates.ts';

/**
 * The plan's Gantt scale: working weeks, Monday to Friday, one column a day.
 * Task spans are working days, so weekends would only be empty stripes; they
 * are left out and a Friday bar meets the Monday bar that follows it.
 * Holidays are real weekdays and keep their column, shaded.
 */

export const GANTT_DAY = 22;
export const GANTT_WEEK = GANTT_DAY * 5;
/** Enough weeks that a short plan still reads as a chart, not a stub. */
export const GANTT_MIN_WEEKS = 8;
/** Never draw more than this, whatever the dates say. */
const MAX_WEEKS = 520;

export type GanttScale = {
  /** A Monday. */
  start: ISODate;
  weeks: number;
};

export function ganttScale(dates: readonly (ISODate | null | undefined)[], minWeeks = GANTT_MIN_WEEKS): GanttScale | null {
  let lo: ISODate | null = null;
  let hi: ISODate | null = null;
  for (const d of dates) {
    if (!d) continue;
    lo = lo ? minDate(lo, d) : d;
    hi = hi ? maxDate(hi, d) : d;
  }
  if (!lo || !hi) return null;
  const start = startOfWeek(lo);
  // One spare week after the last date, so the finish never sits on the edge.
  const needed = Math.floor(diffDays(start, startOfWeek(hi)) / 7) + 2;
  return { start, weeks: Math.min(MAX_WEEKS, Math.max(minWeeks, needed)) };
}

/**
 * The weekday column holding a date. A weekend date has no column: as a start
 * it moves on to Monday, as an end it moves back to Friday.
 */
export function dayColumn(scale: GanttScale, d: ISODate, edge: 'start' | 'end'): number {
  const days = diffDays(scale.start, d);
  let week = Math.floor(days / 7);
  let dow = (dayOfWeek(d) + 6) % 7; // Monday 0 .. Sunday 6
  if (dow >= 5) {
    if (edge === 'start') { week += 1; dow = 0; } else dow = 4;
  }
  return week * 5 + dow;
}

/** Left and right edges of a span, in pixels; the end day is included. */
export function spanX(scale: GanttScale, start: ISODate, end: ISODate, day = GANTT_DAY): { x0: number; x1: number } {
  const x0 = dayColumn(scale, start, 'start') * day;
  const x1 = (dayColumn(scale, end, 'end') + 1) * day;
  return { x0, x1: Math.max(x0, x1) };
}

/** The date in each column, Mondays first, for the header and the shading. */
export function ganttDays(scale: GanttScale): ISODate[] {
  const out: ISODate[] = [];
  for (let w = 0; w < scale.weeks; w++) {
    const monday = addDays(scale.start, w * 7);
    for (let i = 0; i < 5; i++) out.push(addDays(monday, i));
  }
  return out;
}

// ---------------------------------------------------------------- zoom

/**
 * Zoom steps, never continuous (DESIGN.md §16.4): a day is 22px, 8px or 3px.
 * The columns stay weekdays at every step; only the header and gridlines change.
 */
export type Zoom = 'day' | 'week' | 'month';
export const ZOOMS: readonly Zoom[] = ['day', 'week', 'month'];
export const ZOOM_LABEL: Record<Zoom, string> = { day: 'Days', week: 'Weeks', month: 'Months' };
export const DAY_WIDTH: Record<Zoom, number> = { day: GANTT_DAY, week: 8, month: 3 };

/** Weeks enough to fill about this many pixels, so a short plan never looks like a stub. */
export function minWeeksFor(zoom: Zoom, width = 1600): number {
  return Math.max(4, Math.ceil(width / (DAY_WIDTH[zoom] * 5)));
}

/** The widest step at which a span fits the room, so "Fit" shows the whole plan. */
export function zoomToFit(start: ISODate, end: ISODate, room: number): Zoom {
  const cols = (Math.floor(diffDays(startOfWeek(start), startOfWeek(end)) / 7) + 2) * 5;
  return ZOOMS.find((z) => cols * DAY_WIDTH[z] <= room) ?? 'month';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type Band = { col: number; span: number; label: string; sub?: string };

/** Consecutive columns sharing a key become one header cell. Bounded by the column count. */
function bands(days: readonly ISODate[], key: (d: ISODate, i: number) => string, label: (d: ISODate, i: number) => Pick<Band, 'label' | 'sub'>): Band[] {
  const out: Band[] = [];
  let prev: string | null = null;
  days.forEach((d, i) => {
    const k = key(d, i);
    if (k === prev) out[out.length - 1].span++;
    else out.push({ col: i, span: 1, ...label(d, i) });
    prev = k;
  });
  return out;
}

const WEEKDAY_LETTER = ['M', 'T', 'W', 'T', 'F'];
const quarter = (d: ISODate) => Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1;

/** The two header rows for a zoom step: the larger period over the smaller. */
export function headerBands(days: readonly ISODate[], zoom: Zoom): { top: Band[]; bottom: Band[] } {
  if (zoom === 'day') {
    return {
      top: bands(days, (_, i) => String(Math.floor(i / 5)), (d, i) => ({
        label: `Week ${Math.floor(i / 5) + 1}`, sub: `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`,
      })),
      bottom: days.map((_, i) => ({ col: i, span: 1, label: WEEKDAY_LETTER[i % 5] })),
    };
  }
  if (zoom === 'week') {
    return {
      top: bands(days, (d) => d.slice(0, 7), (d) => ({ label: `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}` })),
      bottom: bands(days, (_, i) => String(Math.floor(i / 5)), (d) => ({ label: String(Number(d.slice(8, 10))) })),
    };
  }
  return {
    top: bands(days, (d) => `${d.slice(0, 4)}Q${quarter(d)}`, (d) => ({ label: `Q${quarter(d)} ${d.slice(0, 4)}` })),
    bottom: bands(days, (d) => d.slice(0, 7), (d) => ({ label: MONTHS[Number(d.slice(5, 7)) - 1] })),
  };
}

/** Where vertical rules go: `strong` marks the larger period's edge. */
export function gridLines(days: readonly ISODate[], zoom: Zoom): { col: number; strong: boolean }[] {
  const out: { col: number; strong: boolean }[] = [];
  days.forEach((d, i) => {
    const newMonth = i === 0 || d.slice(0, 7) !== days[i - 1].slice(0, 7);
    const newQuarter = newMonth && (i === 0 || quarter(d) !== quarter(days[i - 1]) || d.slice(0, 4) !== days[i - 1].slice(0, 4));
    if (zoom === 'day') out.push({ col: i, strong: i % 5 === 0 });
    else if (zoom === 'week') { if (i % 5 === 0 || newMonth) out.push({ col: i, strong: newMonth }); }
    else if (newMonth) out.push({ col: i, strong: newQuarter });
  });
  return out;
}

// ---------------------------------------------------------------- drag

/** The weekday in a column, clamped to the scale. */
export function dateAtColumn(scale: GanttScale, col: number): ISODate {
  const c = Math.max(0, Math.min(scale.weeks * 5 - 1, col));
  return addDays(scale.start, Math.floor(c / 5) * 7 + (c % 5));
}

/**
 * Where a dragged start lands: whole columns from where it was, then onto a
 * working day going forward, so a holiday column never holds a start.
 */
export function draggedStart(scale: GanttScale, start: ISODate, cols: number, holidays: HolidaySet): ISODate {
  return snapToWorkingDay(dateAtColumn(scale, dayColumn(scale, start, 'start') + cols), holidays, 1);
}

/** Where a dragged finish lands: back onto a working day, never before the start. */
export function draggedFinish(scale: GanttScale, start: ISODate, end: ISODate, cols: number, holidays: HolidaySet): ISODate {
  const d = snapToWorkingDay(dateAtColumn(scale, dayColumn(scale, end, 'end') + cols), holidays, -1);
  return d < start ? start : d;
}

/** Where a dragged left end lands: forward onto a working day, never after the finish. */
export function draggedStartEdge(scale: GanttScale, start: ISODate, end: ISODate, cols: number, holidays: HolidaySet): ISODate {
  const d = draggedStart(scale, start, cols, holidays);
  return d > end ? end : d;
}

/**
 * What a new start means. Dates are scheduled, so it becomes the floor the task
 * may not start before, or, once work has begun, the day it actually started.
 * A typed start and a dragged bar both go through here.
 */
export function startFields(t: Pick<Task, 'status' | 'actual_start'>, date: ISODate): TaskInput {
  const started = (t.status === 'in_progress' || t.status === 'done') && t.actual_start;
  return started ? { actual_start: date } : { not_before: date };
}

/**
 * What a new finish means: the working days from the start to it become the
 * length; a done task records it as its actual finish. Null before the start.
 */
export function finishFields(t: Pick<Task, 'status' | 'duration'>, start: ISODate, date: ISODate, holidays?: HolidaySet): TaskInput | null {
  if (date < start) return null;
  if (t.status === 'done') return { actual_end: date };
  if (t.duration === 0) return { not_before: date };
  return { duration: Math.max(1, workingDays(start, date, holidays)) };
}

/**
 * What a dragged left end means: the task starts on `date` and still finishes
 * on `end`, so the length becomes the working days between. A done task with
 * an actual finish keeps it and only records the new actual start. Null after the finish.
 */
export function startEdgeFields(
  t: Pick<Task, 'status' | 'actual_start' | 'duration'> & { actual_end?: ISODate | null }, date: ISODate, end: ISODate, holidays?: HolidaySet,
): TaskInput | null {
  if (date > end) return null;
  const fields = startFields(t, date);
  if ((t.status === 'done' && t.actual_end) || t.duration === 0) return fields;
  return { ...fields, duration: Math.max(1, workingDays(date, end, holidays)) };
}

/** Working days a finish sits past (positive) or before (negative) its baseline. */
export function finishVariance(baselineEnd: ISODate, end: ISODate, holidays?: HolidaySet): number {
  if (end === baselineEnd) return 0;
  return end > baselineEnd
    ? workingDays(addDays(baselineEnd, 1), end, holidays)
    : -workingDays(addDays(end, 1), baselineEnd, holidays);
}

// ---------------------------------------------------------------- progress

type ProgressTask = Pick<Task, 'status' | 'duration' | 'actual_start'> & { progress?: number | null };

/**
 * Percent complete: what someone typed, else what the status says. Work in
 * progress with no figure is estimated from working days elapsed, capped short
 * of done, because only "Done" means done.
 */
export function progressOf(t: ProgressTask, today: ISODate, holidays?: HolidaySet): number {
  if (t.progress != null) return Math.max(0, Math.min(100, t.progress));
  if (t.status === 'done') return 100;
  if (t.status !== 'in_progress' || !t.actual_start || t.duration <= 0 || today < t.actual_start) return 0;
  return Math.min(95, Math.round((workingDays(t.actual_start, today, holidays) / t.duration) * 100));
}

/**
 * Baselines with each summary's rolled up from its tasks' (earliest start, latest
 * finish), so a summary made or reshaped after the baseline still compares.
 */
export function rolledBaseline(
  tasks: readonly { id: number; sort_order: number; parent_id?: number | null }[],
  saved: ReadonlyMap<number, { start: ISODate; end: ISODate }>,
): Map<number, { start: ISODate; end: ISODate }> {
  const out = new Map(saved);
  for (const id of summaryIds(tasks)) {
    const spans = leavesOf(tasks, id).map((l) => saved.get(l)).filter((b): b is { start: ISODate; end: ISODate } => !!b);
    if (!spans.length) { out.delete(id); continue; }
    out.set(id, {
      start: spans.reduce((m, b) => (b.start < m ? b.start : m), spans[0].start),
      end: spans.reduce((m, b) => (b.end > m ? b.end : m), spans[0].end),
    });
  }
  return out;
}

/** A summary's progress: its tasks' progress weighted by their length. */
export function rolledProgress(parts: readonly { progress: number; duration: number }[]): number {
  if (!parts.length) return 0;
  const weight = parts.reduce((s, p) => s + Math.max(1, p.duration), 0);
  return Math.round(parts.reduce((s, p) => s + p.progress * Math.max(1, p.duration), 0) / weight);
}

// ---------------------------------------------------------------- tracing and visibility

/** Everything a task waits on and everything waiting on it, at any distance. */
export function chainOf(id: number, deps: readonly Pick<TaskDependency, 'predecessor_id' | 'successor_id'>[]): Set<number> {
  const out = new Set<number>([id]);
  const walk = (from: 'predecessor_id' | 'successor_id', to: 'predecessor_id' | 'successor_id') => {
    const queue = [id];
    const seen = new Set(queue);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const d of deps) {
        if (d[from] !== cur || seen.has(d[to])) continue;
        seen.add(d[to]);
        out.add(d[to]);
        queue.push(d[to]);
      }
    }
  };
  walk('successor_id', 'predecessor_id');
  walk('predecessor_id', 'successor_id');
  return out;
}

/**
 * Which rows show: a row matching the filter, with its summaries so the outline
 * still reads, and never a row under a collapsed summary.
 */
export function visibleRows(
  rows: readonly { id: number; parent_id: number | null }[],
  matches: (id: number) => boolean,
  collapsed: ReadonlySet<number>,
): Set<number> {
  const parent = new Map(rows.map((r) => [r.id, r.parent_id]));
  const ancestors = (id: number) => {
    const out: number[] = [];
    let cur = parent.get(id) ?? null;
    let guard = 0;
    while (cur != null && guard++ < rows.length) { out.push(cur); cur = parent.get(cur) ?? null; }
    return out;
  };
  const shown = new Set<number>();
  for (const r of rows) {
    if (!matches(r.id)) continue;
    shown.add(r.id);
    for (const a of ancestors(r.id)) shown.add(a);
  }
  for (const r of rows) if (ancestors(r.id).some((a) => collapsed.has(a))) shown.delete(r.id);
  return shown;
}
