import { describe, expect, it } from 'vitest';
import { buildRows } from '../client/components/Board.tsx';
import { packLanes, laneCount, makeScale, majorTicks } from '../client/layout.ts';
import { addDays as addDaysISO, addMonths } from '../shared/dates.ts';
import { detectConflicts } from '../shared/conflicts.ts';
import type { BookingView, Environment, Project } from '../shared/types.ts';

let nextId = 1;
const booking = (p: Partial<BookingView> & { start_date: string; end_date: string }): BookingView => ({
  id: nextId++, project_id: 1, environment_id: 1, kind: 'SIT', confidence: 'committed', optional: 0,
  project_name: 'Project', team_id: 1, priority: 'normal', env_name: 'SIT', env_kind: 'SIT',
  capacity: 1, calendar_days: 1, working_days: 1, is_milestone: false, ...p,
});

const env = (id: number, name: string, capacity = 1): Environment =>
  ({ id, team_id: 1, name, kind: 'SIT', capacity, sort_order: id });

const project = (id: number, name: string): Project =>
  ({ id, team_id: 1, parent_id: null, name, status: 'planned', priority: 'normal',
     owner: null, description: null, external_link: null });

describe('packLanes', () => {
  it('keeps non-overlapping bookings on one lane', () => {
    const placed = packLanes([
      booking({ start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ start_date: '2026-03-09', end_date: '2026-03-13' }),
    ]);
    expect(laneCount(placed)).toBe(1);
  });

  it('stacks overlapping bookings so a pile-up is physically visible', () => {
    const placed = packLanes([
      booking({ start_date: '2026-03-02', end_date: '2026-03-20' }),
      booking({ start_date: '2026-03-04', end_date: '2026-03-18' }),
      booking({ start_date: '2026-03-06', end_date: '2026-03-16' }),
    ]);
    expect(laneCount(placed)).toBe(3);
    expect(placed.map((p) => p.lane).sort()).toEqual([0, 1, 2]);
  });

  it('reuses a lane once it frees up', () => {
    const placed = packLanes([
      booking({ start_date: '2026-03-02', end_date: '2026-03-10' }),
      booking({ start_date: '2026-03-05', end_date: '2026-03-12' }),
      booking({ start_date: '2026-03-20', end_date: '2026-03-25' }),
    ]);
    expect(laneCount(placed)).toBe(2);
  });
});

describe('buildRows', () => {
  const bookings = [
    booking({ id: 101, project_id: 1, project_name: 'Payments', environment_id: 1, start_date: '2026-03-02', end_date: '2026-03-13' }),
    booking({ id: 102, project_id: 2, project_name: 'Billing', environment_id: 1, start_date: '2026-03-09', end_date: '2026-03-20' }),
    booking({ id: 103, project_id: 1, project_name: 'Payments', environment_id: 2, env_name: 'UAT', start_date: '2026-03-23', end_date: '2026-03-27' }),
  ];
  const data = {
    bookings,
    projects: [project(1, 'Payments'), project(2, 'Billing')],
    environments: [env(1, 'SIT'), env(2, 'UAT')],
    conflicts: detectConflicts(bookings),
  };
  const all = new Set([1, 2]);

  it('makes one row per environment in environment mode', () => {
    const rows = buildRows('environment', data, all, '2026-03-10');
    expect(rows.map((r) => r.name)).toEqual(['SIT', 'UAT']);
    expect(rows[0].bookings).toHaveLength(2);
  });

  it('reports live occupancy against capacity', () => {
    const rows = buildRows('environment', data, all, '2026-03-10');
    // Both bookings are live on 10 Mar, in an environment with room for one.
    expect(rows[0].occupancy).toEqual({ booked: 2, capacity: 1 });
    expect(rows[1].occupancy).toEqual({ booked: 0, capacity: 1 });
  });

  it('makes one row per project in project mode', () => {
    const rows = buildRows('project', data, all, '2026-03-10');
    expect(rows.map((r) => r.name).sort()).toEqual(['Billing', 'Payments']);
  });

  it('drops rows the environment filter hides', () => {
    const rows = buildRows('environment', data, new Set([2]), '2026-03-10');
    expect(rows.map((r) => r.name)).toEqual(['UAT']);
  });

  it('keeps a hidden environment out of project rows too', () => {
    const rows = buildRows('project', data, new Set([2]), '2026-03-10');
    // Only Payments has a UAT booking, so Billing has nothing left to draw.
    expect(rows.map((r) => r.name)).toEqual(['Payments']);
    expect(rows[0].bookings).toHaveLength(1);
  });

  it('still shows a project that has never been booked', () => {
    // Otherwise a newly added project is invisible and cannot be reached.
    const withEmpty = {
      ...data,
      projects: [...data.projects, { ...project(3, 'Not started'), booking_count: 0 }],
    };
    const rows = buildRows('project', withEmpty, all, '2026-03-10');
    const row = rows.find((r) => r.name === 'Not started');
    expect(row).toBeDefined();
    expect(row!.bookings).toHaveLength(0);
    expect(row!.meta).toBe('nothing booked yet');
  });

  it('hides a booked project whose bookings are all filtered out, not treating it as empty', () => {
    const counted = {
      ...data,
      projects: [
        { ...project(1, 'Payments'), booking_count: 2 },
        { ...project(2, 'Billing'), booking_count: 1 },
      ],
    };
    const rows = buildRows('project', counted, new Set([2]), '2026-03-10');
    expect(rows.map((r) => r.name)).toEqual(['Payments']);
  });

  it('marks both sides of a clash as conflicted in project mode', () => {
    const rows = buildRows('project', data, all, '2026-03-10');
    expect(rows.every((r) => r.conflicts.length > 0)).toBe(true);
  });
});

describe('ruler', () => {
  const ZOOMS = ['week', 'month', 'quarter'] as const;

  // Regression: the quarter walk used to advance one month then re-align to the
  // quarter start, which snapped backwards and span forever, freezing the tab.
  it.each(ZOOMS)('produces a finite, strictly increasing ruler at %s zoom', (zoom) => {
    const scale = makeScale(zoom, '2026-09-21');
    const ticks = majorTicks(scale);

    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks.length).toBeLessThan(80);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i].date > ticks[i - 1].date).toBe(true);
    }
  });

  it.each(ZOOMS)('never repeats a label at %s zoom', (zoom) => {
    const labels = majorTicks(makeScale(zoom, '2026-09-21')).map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  // Every day of a year as the anchor: any alignment that could stall shows up here.
  it('terminates from every start date in a year, at every zoom', () => {
    for (const zoom of ZOOMS) {
      for (let i = 0; i < 365; i++) {
        const anchor = addDaysISO('2026-01-01', i);
        const ticks = majorTicks(makeScale(zoom, anchor));
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.length).toBeLessThan(80);
      }
    }
  });

  it('labels quarters as quarters and months as months', () => {
    expect(majorTicks(makeScale('quarter', '2026-09-21'))[0].label).toMatch(/^Q[1-4] \d{4}$/);
    expect(majorTicks(makeScale('month', '2026-09-21'))[0].label).toMatch(/^[A-Z][a-z]{2}/);
  });

  it('drops a clamped leading tick that would overprint the next one', () => {
    const ticks = majorTicks(makeScale('month', '2026-09-21'));
    expect(ticks[1] && (ticks[1].date > ticks[0].date)).toBe(true);
  });
});

describe('addMonths', () => {
  it('steps whole months', () => {
    expect(addMonths('2026-01-01', 1)).toBe('2026-02-01');
    expect(addMonths('2026-10-01', 3)).toBe('2027-01-01');
    expect(addMonths('2026-03-01', -3)).toBe('2025-12-01');
  });

  it('clamps to the shorter month instead of spilling over', () => {
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29');
  });
});

describe('milestone labels', () => {
  it('pushes crowded release markers onto separate lanes', () => {
    // Two releases four days apart: zero-width bars, but labels that would
    // otherwise print on top of each other at month zoom.
    const releases = [
      booking({ kind: 'RELEASE', is_milestone: true, project_name: 'Card tokenisation R2',
                start_date: '2026-03-10', end_date: '2026-03-10' }),
      booking({ kind: 'RELEASE', is_milestone: true, project_name: 'Settlement rewrite',
                start_date: '2026-03-14', end_date: '2026-03-14' }),
    ];
    expect(laneCount(packLanes(releases, 11))).toBe(2);

    // Spread the same two releases further apart and one lane holds them.
    const spread = [
      booking({ kind: 'RELEASE', is_milestone: true, project_name: 'Card tokenisation R2',
                start_date: '2026-03-10', end_date: '2026-03-10' }),
      booking({ kind: 'RELEASE', is_milestone: true, project_name: 'Settlement rewrite',
                start_date: '2026-03-30', end_date: '2026-03-30' }),
    ];
    expect(laneCount(packLanes(spread, 11))).toBe(1);

    // Zooming in never needs more lanes than zooming out.
    expect(laneCount(packLanes(releases, 34))).toBeLessThanOrEqual(laneCount(packLanes(releases, 4)));
  });

  it('leaves ordinary bars unaffected by the label allowance', () => {
    const bars = [
      booking({ start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ start_date: '2026-03-09', end_date: '2026-03-13' }),
    ];
    expect(laneCount(packLanes(bars, 11))).toBe(1);
  });
});
