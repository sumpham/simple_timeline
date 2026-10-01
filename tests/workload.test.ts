import { describe, expect, it } from 'vitest';
import { countsAsWork, personOverlaps, type WorkItem } from '../shared/workload.ts';

const w = (task_id: number, resource_ids: number[], start: string, end: string, project_id = 1): WorkItem =>
  ({ task_id, project_id, resource_ids, start, end });

describe('personOverlaps', () => {
  it('finds a person on two tasks that share working days', () => {
    // 2026-10-05 is a Monday.
    const got = personOverlaps([w(1, [7], '2026-10-05', '2026-10-09'), w(2, [7], '2026-10-08', '2026-10-14')]);
    expect(got.get(7)).toEqual([{ resource_id: 7, a: 1, b: 2, start: '2026-10-08', end: '2026-10-09', days: 2 }]);
  });

  it('counts working days, so Friday then Monday is no clash, and a weekend-only overlap is none', () => {
    expect(personOverlaps([w(1, [7], '2026-10-05', '2026-10-09'), w(2, [7], '2026-10-12', '2026-10-16')]).size).toBe(0);
    expect(personOverlaps([w(1, [7], '2026-10-05', '2026-10-10'), w(2, [7], '2026-10-11', '2026-10-16')]).size).toBe(0);
  });

  it('skips holidays', () => {
    const items = [w(1, [7], '2026-10-05', '2026-10-08'), w(2, [7], '2026-10-08', '2026-10-09')];
    expect(personOverlaps(items).get(7)![0].days).toBe(1);
    expect(personOverlaps(items, new Set(['2026-10-08'])).size).toBe(0);
  });

  it('keeps people apart and works across projects', () => {
    const got = personOverlaps([
      w(1, [7, 8], '2026-10-05', '2026-10-09'),
      w(2, [8], '2026-10-07', '2026-10-07', 2),
      w(3, [9], '2026-10-05', '2026-10-09'),
    ]);
    expect([...got.keys()]).toEqual([8]);
    expect(got.get(8)![0]).toMatchObject({ a: 1, b: 2, days: 1 });
  });

  it('lists every pair once, earliest first', () => {
    const got = personOverlaps([
      w(3, [7], '2026-10-07', '2026-10-09'),
      w(1, [7], '2026-10-05', '2026-10-09'),
      w(2, [7], '2026-10-06', '2026-10-06'),
    ]).get(7)!;
    expect(got.map((o) => [o.a, o.b])).toEqual([[1, 2], [1, 3]]);
  });
});

describe('countsAsWork', () => {
  const t = { status: 'todo', duration: 3, start_date: '2026-10-05', end_date: '2026-10-07' };
  it('leaves out summaries, milestones, done work and undated tasks', () => {
    expect(countsAsWork(t, false)).toBe(true);
    expect(countsAsWork(t, true)).toBe(false);
    expect(countsAsWork({ ...t, duration: 0 }, false)).toBe(false);
    expect(countsAsWork({ ...t, status: 'done' }, false)).toBe(false);
    expect(countsAsWork({ ...t, start_date: null }, false)).toBe(false);
  });
});
