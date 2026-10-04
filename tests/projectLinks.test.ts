import { describe, expect, it } from 'vitest';
import { downstreamOf, externalFloors, formatExternal, linkFloor, parseExternal, projectOrder, projectTags } from '../shared/projectLinks.ts';
import { scheduleProject } from '../shared/schedule.ts';
import type { Task } from '../shared/types.ts';

// 2026-03-02 is a Monday; 2026-03-06 a Friday.
const pred = { start: '2026-03-02', end: '2026-03-06' };

function task(id: number, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 2, environment_id: null, name: `T${id}`, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null, code: id,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}

describe('links between projects', () => {
  it('set a floor the way a link inside a plan would, in working days', () => {
    expect(linkFloor({ type: 'FS', lag: 0 }, pred, 3)).toBe('2026-03-09');
    expect(linkFloor({ type: 'FS', lag: 2 }, pred, 3)).toBe('2026-03-11');
    expect(linkFloor({ type: 'SS', lag: 1 }, pred, 3)).toBe('2026-03-03');
    // FF: finish no earlier than Friday's next day minus three days of work: start Thu 4 Mar.
    expect(linkFloor({ type: 'FF', lag: 0 }, pred, 3)).toBe('2026-03-04');
    // A milestone on Friday marks the end of that day, as inside a plan: Monday.
    expect(linkFloor({ type: 'FS', lag: 0 }, { start: '2026-03-06', end: '2026-03-06' }, 3)).toBe('2026-03-09');
  });

  it('take the latest of several floors, and hold the task through the scheduler, never through not_before', () => {
    const floors = externalFloors([
      { successor_id: 5, type: 'FS', lag: 0, pred },
      { successor_id: 5, type: 'FS', lag: 0, pred: { start: '2026-03-02', end: '2026-03-03' } },
      { successor_id: 6, type: 'FS', lag: 0, pred: null },
    ], () => 2);
    expect([...floors]).toEqual([[5, '2026-03-09']]);
    const t = task(5, 2);
    const r = scheduleProject({ tasks: [t], deps: [], projectStart: '2026-03-02', external: floors });
    if ('cycle' in r) throw new Error();
    expect(r.tasks.get(5)).toMatchObject({ start: '2026-03-09', end: '2026-03-10' });
    expect(t.not_before).toBeNull();
    // Its own later "no earlier than" still wins.
    const own = scheduleProject({ tasks: [task(5, 2, { not_before: '2026-03-16' })], deps: [], projectStart: '2026-03-02', external: floors });
    if ('cycle' in own) throw new Error();
    expect(own.tasks.get(5)!.start).toBe('2026-03-16');
  });

  it('replan projects upstream first, and refuse a loop between them, naming it', () => {
    expect(projectOrder([1, 2, 3], [[3, 1], [1, 2]])).toEqual({ order: [3, 1, 2] });
    expect(projectOrder([1, 2, 3], [[1, 2], [2, 3], [3, 1]])).toEqual({ cycle: [1, 2, 3, 1] });
    expect(downstreamOf(1, [3, 1, 2, 4], [[3, 1], [1, 2], [2, 4]])).toEqual([2, 4]);
    expect(downstreamOf(4, [3, 1, 2, 4], [[3, 1], [1, 2], [2, 4]])).toEqual([]);
  });

  it('are typed in After as a project tag, a colon and a task ID', () => {
    const projects = [{ id: 1, name: 'Refund API v3' }, { id: 2, name: 'Card tokenisation R2' }, { id: 3, name: 'Card wallet' }, { id: 4, name: 'Mobile app 5.0' }];
    expect([...projectTags(projects)]).toEqual([[1, 'Refund'], [2, 'CardtokenisationR2'], [3, 'Cardwallet'], [4, 'Mobile']]);
    expect(parseExternal('refund:12SS+2', projects, 4)).toEqual({ ok: true, ref: { project_id: 1, code: 12, type: 'SS', lag: 2 } });
    expect(parseExternal('Cardw:3', projects, 4)).toEqual({ ok: true, ref: { project_id: 3, code: 3, type: 'FS', lag: 0 } });
    expect(parseExternal('Card:3', projects, 4)).toEqual({ ok: false, error: '“Card” could be Card tokenisation R2 or Card wallet. Write more of the name.' });
    expect(parseExternal('Mobile:1', projects, 4)).toEqual({ ok: false, error: 'No other plan in this team is called “Mobile”.' });
    expect(formatExternal('Refund', 12, 'SS', -1)).toBe('Refund:12SS-1');
  });
});
