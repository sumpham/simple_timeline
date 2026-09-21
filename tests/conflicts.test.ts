import { describe, expect, it } from 'vitest';
import { detectConflicts, nextBookingAfter, occupancyOn } from '../shared/conflicts.ts';
import type { BookingView } from '../shared/types.ts';

let nextId = 1;

function booking(partial: Partial<BookingView> & { start_date: string; end_date: string }): BookingView {
  return {
    id: nextId++,
    project_id: 1,
    environment_id: 1,
    kind: 'SIT',
    confidence: 'committed',
    optional: 0,
    project_name: 'Project',
    team_id: 1,
    priority: 'normal',
    env_name: 'SIT',
    env_kind: 'SIT',
    capacity: 1,
    calendar_days: 1,
    working_days: 1,
    is_milestone: false,
    ...partial,
  };
}

describe('detectConflicts', () => {
  it('finds nothing when bookings queue up cleanly', () => {
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ project_id: 2, start_date: '2026-03-09', end_date: '2026-03-13' }),
    ];
    expect(detectConflicts(b)).toEqual([]);
  });

  it('treats back-to-back bookings as free of conflict', () => {
    // Ending Mar 6 and starting Mar 7 must not collide -- this is the classic
    // off-by-one in inclusive-range overlap detection.
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ project_id: 2, start_date: '2026-03-07', end_date: '2026-03-13' }),
    ];
    expect(detectConflicts(b)).toEqual([]);
  });

  it('flags a single shared day', () => {
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ project_id: 2, start_date: '2026-03-06', end_date: '2026-03-13' }),
    ];
    const [c] = detectConflicts(b);
    expect(c.start_date).toBe('2026-03-06');
    expect(c.end_date).toBe('2026-03-06');
    expect(c.overlap_days).toBe(1);
    expect(c.peak).toBe(2);
  });

  it('reports the overlapping stretch, not the whole booking', () => {
    const b = [
      booking({ project_id: 1, project_name: 'Payments', start_date: '2026-03-02', end_date: '2026-03-13' }),
      booking({ project_id: 2, project_name: 'Billing', start_date: '2026-03-09', end_date: '2026-03-20' }),
    ];
    const [c] = detectConflicts(b);
    expect(c.start_date).toBe('2026-03-09');
    expect(c.end_date).toBe('2026-03-13');
    expect(c.overlap_days).toBe(5);
    expect(c.projects.map((p) => p.name).sort()).toEqual(['Billing', 'Payments']);
  });

  it('holds the environment across a weekend', () => {
    // Occupancy is calendar-based: a Fri-Mon booking blocks the Sat-Sun gap too.
    const b = [
      booking({ project_id: 1, start_date: '2026-03-06', end_date: '2026-03-09' }),
      booking({ project_id: 2, start_date: '2026-03-07', end_date: '2026-03-08' }),
    ];
    const [c] = detectConflicts(b);
    expect(c.overlap_days).toBe(2);
  });

  it('respects capacity above one', () => {
    const two = { capacity: 2 };
    const b = [
      booking({ ...two, project_id: 1, start_date: '2026-03-02', end_date: '2026-03-20' }),
      booking({ ...two, project_id: 2, start_date: '2026-03-02', end_date: '2026-03-20' }),
    ];
    expect(detectConflicts(b)).toEqual([]);

    b.push(booking({ ...two, project_id: 3, start_date: '2026-03-10', end_date: '2026-03-12' }));
    const [c] = detectConflicts(b);
    expect(c.peak).toBe(3);
    expect(c.start_date).toBe('2026-03-10');
    expect(c.end_date).toBe('2026-03-12');
  });

  it('keeps separate environments separate', () => {
    const b = [
      booking({ environment_id: 1, project_id: 1, start_date: '2026-03-02', end_date: '2026-03-20' }),
      booking({ environment_id: 2, project_id: 2, start_date: '2026-03-02', end_date: '2026-03-20' }),
    ];
    expect(detectConflicts(b)).toEqual([]);
  });

  it('ignores tentative bookings unless asked', () => {
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-20' }),
      booking({ project_id: 2, confidence: 'tentative', start_date: '2026-03-02', end_date: '2026-03-20' }),
    ];
    expect(detectConflicts(b)).toEqual([]);
    expect(detectConflicts(b, { includeTentative: true })).toHaveLength(1);
  });

  it('ignores milestones, which occupy nothing', () => {
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-20' }),
      booking({ project_id: 2, kind: 'RELEASE', is_milestone: true, start_date: '2026-03-10', end_date: '2026-03-10' }),
    ];
    expect(detectConflicts(b)).toEqual([]);
  });

  it('splits two separate collisions in one environment', () => {
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ project_id: 2, start_date: '2026-03-05', end_date: '2026-03-09' }),
      booking({ project_id: 3, start_date: '2026-03-20', end_date: '2026-03-25' }),
      booking({ project_id: 4, start_date: '2026-03-24', end_date: '2026-03-28' }),
    ];
    const conflicts = detectConflicts(b);
    expect(conflicts).toHaveLength(2);
    expect(conflicts.map((c) => c.start_date).sort()).toEqual(['2026-03-05', '2026-03-24']);
  });

  it('ranks severity by overlap length and priority', () => {
    const b = [
      booking({ environment_id: 1, project_id: 1, start_date: '2026-03-02', end_date: '2026-03-04' }),
      booking({ environment_id: 1, project_id: 2, priority: 'critical', start_date: '2026-03-02', end_date: '2026-03-04' }),
      booking({ environment_id: 2, env_name: 'UAT', project_id: 3, start_date: '2026-03-02', end_date: '2026-03-06' }),
      booking({ environment_id: 2, env_name: 'UAT', project_id: 4, priority: 'low', start_date: '2026-03-02', end_date: '2026-03-06' }),
    ];
    const conflicts = detectConflicts(b);
    // 3 days x critical(4) = 12 outranks 5 days x normal(2) = 10.
    expect(conflicts[0].environment_id).toBe(1);
    expect(conflicts[0].severity).toBe(12);
    expect(conflicts[1].severity).toBe(10);
  });

  it('merges a three-way pileup into one stretch', () => {
    const b = [
      booking({ project_id: 1, start_date: '2026-03-02', end_date: '2026-03-12' }),
      booking({ project_id: 2, start_date: '2026-03-04', end_date: '2026-03-14' }),
      booking({ project_id: 3, start_date: '2026-03-06', end_date: '2026-03-16' }),
    ];
    const conflicts = detectConflicts(b);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].peak).toBe(3);
    expect(conflicts[0].projects).toHaveLength(3);
    expect(conflicts[0].start_date).toBe('2026-03-04');
    expect(conflicts[0].end_date).toBe('2026-03-14');
  });
});

describe('occupancy', () => {
  const b = [
    booking({ project_id: 1, project_name: 'Payments', start_date: '2026-03-02', end_date: '2026-03-06' }),
    booking({ project_id: 2, project_name: 'Billing', start_date: '2026-03-16', end_date: '2026-03-20' }),
  ];

  it('names who holds the environment today', () => {
    expect(occupancyOn(b, 1, '2026-03-04').map((x) => x.project_name)).toEqual(['Payments']);
    expect(occupancyOn(b, 1, '2026-03-10')).toEqual([]);
  });

  it('names who is next', () => {
    expect(nextBookingAfter(b, 1, '2026-03-04')?.project_name).toBe('Billing');
    expect(nextBookingAfter(b, 1, '2026-03-25')).toBeNull();
  });
});
