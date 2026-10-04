import { maxDate, minDate, workingDays, type HolidaySet } from './dates.ts';
import type { ISODate } from './types.ts';

/**
 * A person on two tasks at once (reqs/resources.md §7, workload). People do not
 * work weekends, so an overlap counts **working days**, never calendar days: a
 * task ending Friday and one starting Monday do not clash. Environments stay on
 * `detectConflicts`; people never pass through it.
 */

/** One piece of work someone is on: a leaf task with dates, from any project. */
export type WorkItem = {
  task_id: number;
  project_id: number;
  resource_ids: readonly number[];
  start: ISODate;
  end: ISODate;
};

/** Two tasks one person is on that share at least one working day. */
export type PersonOverlap = {
  resource_id: number;
  /** The task that starts first (by id when they start together), then the other. */
  a: number;
  b: number;
  start: ISODate;
  end: ISODate;
  /** Working days the two tasks share. */
  days: number;
};

/**
 * Whether a task counts as work for a person. Summaries are roll-ups and their
 * people are owners; milestones take no time; done work cannot clash any more.
 */
export function countsAsWork(t: {
  status: string; duration: number; start_date: ISODate | null; end_date: ISODate | null;
}, summary: boolean): boolean {
  return !summary && t.status !== 'done' && t.duration > 0 && !!t.start_date && !!t.end_date;
}

/** Every pair of a person's tasks that share a working day, per person, earliest first. */
export function personOverlaps(items: readonly WorkItem[], holidays: HolidaySet = new Set()): Map<number, PersonOverlap[]> {
  const byPerson = new Map<number, WorkItem[]>();
  for (const it of items) {
    for (const r of new Set(it.resource_ids)) {
      if (!byPerson.has(r)) byPerson.set(r, []);
      byPerson.get(r)!.push(it);
    }
  }
  const out = new Map<number, PersonOverlap[]>();
  for (const [resource_id, work] of byPerson) {
    work.sort((x, y) => x.start.localeCompare(y.start) || x.task_id - y.task_id);
    const found: PersonOverlap[] = [];
    for (let i = 0; i < work.length; i++) {
      // Sorted by start, so once a task starts after this one ends, none later can overlap it.
      for (let j = i + 1; j < work.length && work[j].start <= work[i].end; j++) {
        if (work[j].task_id === work[i].task_id) continue;
        const start = maxDate(work[i].start, work[j].start);
        const end = minDate(work[i].end, work[j].end);
        const days = workingDays(start, end, holidays);
        if (days > 0) found.push({ resource_id, a: work[i].task_id, b: work[j].task_id, start, end, days });
      }
    }
    if (found.length) out.set(resource_id, found);
  }
  return out;
}

/** A plan's own work, as `personOverlaps` reads it: leaf tasks with people and dates, by the scheduled span. */
export function workItems(
  tasks: readonly { id: number; project_id: number; status: string; duration: number }[],
  schedule: ReadonlyMap<number, { start: ISODate; end: ISODate; summary?: boolean }>,
  peopleOf: (taskId: number) => readonly number[] | undefined,
): WorkItem[] {
  const out: WorkItem[] = [];
  for (const t of tasks) {
    const s = schedule.get(t.id);
    const people = peopleOf(t.id);
    if (!s || !people?.length || !countsAsWork({ ...t, start_date: s.start, end_date: s.end }, !!s.summary)) continue;
    out.push({ task_id: t.id, project_id: t.project_id, resource_ids: people, start: s.start, end: s.end });
  }
  return out;
}

/** The overlaps that involve at least one task of this plan, counting people's work in other plans. */
export function planOverlaps(here: readonly WorkItem[], elsewhere: readonly WorkItem[], holidays: HolidaySet = new Set()): Map<number, PersonOverlap[]> {
  const ours = new Set(here.map((w) => w.task_id));
  const all = personOverlaps([...here, ...elsewhere], holidays);
  for (const [r, list] of all) {
    const kept = list.filter((o) => ours.has(o.a) || ours.has(o.b));
    if (kept.length) all.set(r, kept); else all.delete(r);
  }
  return all;
}

/** How many of a person's work items cover each of `days`: 0 free, 1 busy, 2 or more on two things at once. */
export function loadByDay(items: readonly WorkItem[], resourceId: number, days: readonly ISODate[]): number[] {
  const mine = items.filter((it) => it.resource_ids.includes(resourceId));
  return days.map((d) => mine.filter((it) => it.start <= d && d <= it.end).length);
}
