import { describe, expect, it } from 'vitest';
import { fromCsv, fromMspdi, parseCsvText, toCsv, toMspdi } from '../client/planIO.ts';
import { outline } from '../shared/wbs.ts';
import type { Environment, Task, TaskDependency, TaskSchedule } from '../shared/types.ts';

function task(id: number, name: string, duration: number, partial: Partial<Task> = {}): Task {
  return {
    id, project_id: 1, environment_id: null, name, duration, status: 'todo', not_before: null,
    note: null, sort_order: id, actual_start: null, actual_end: null,
    start_date: null, end_date: null, total_float: null, critical: 0, ...partial,
  };
}
const env = { id: 5, name: 'SIT', kind: 'SIT', capacity: 1, team_id: 1 } as Environment;
const tasks = [
  task(10, 'Build', 0),
  task(11, 'Code, "fast"', 3, { parent_id: 10, environment_id: 5 }),
  task(12, 'Test', 2, { parent_id: 10, progress: 40 }),
  task(13, 'Ship', 0),
];
const deps: TaskDependency[] = [
  { predecessor_id: 11, successor_id: 12, lag: 1, type: 'SS' },
  { predecessor_id: 10, successor_id: 13, lag: 0, type: 'FS' },
];
const schedule = new Map<number, TaskSchedule>([10, 11, 12, 13].map((id) => [id, {
  id, start: '2026-03-02', end: '2026-03-04', late_start: '2026-03-02', late_end: '2026-03-04', total_float: 0, free_float: 0, critical: true,
}]));
const plan = { tasks, outline: outline(tasks), schedule, deps, environments: [env] };

describe('CSV', () => {
  it('parses quotes, doubled quotes and newlines inside cells', () => {
    expect(parseCsvText('a,"b, c","d ""e"""\r\n"x\ny",z\n')).toEqual([['a', 'b, c', 'd "e"'], ['x\ny', 'z']]);
  });

  it('round-trips the outline, links, environment and progress', () => {
    const back = fromCsv(toCsv(plan));
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => [r.name, r.parent, r.duration, r.environment, r.progress])).toEqual([
      ['Build', null, 1, null, null], ['Code, "fast"', 1, 3, 'SIT', null], ['Test', 1, 2, null, 40], ['Ship', null, 0, null, null],
    ]);
    expect(back.rows[2].predecessors).toEqual([{ row: 2, lag: 1, type: 'SS' }]);
    expect(back.rows[3].predecessors).toEqual([{ row: 1, lag: 0, type: 'FS' }]);
  });

  it('writes TaskIDs, and After in them, and reads them back', () => {
    const coded = tasks.map((t, i) => ({ ...t, code: [40, 7, 12, 3][i] }));
    const csv = toCsv({ ...plan, tasks: coded });
    expect(csv.split('\r\n')[0].startsWith('ID,')).toBe(true);
    expect(csv.split('\r\n')[3].startsWith('12,1.2,Test,40,,2,7SS+1,')).toBe(true);
    const back = fromCsv(csv);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => r.code)).toEqual([40, 7, 12, 3]);
    expect(back.rows[2].predecessors).toEqual([{ row: 2, lag: 1, type: 'SS' }]);
  });

  it('takes a plain spreadsheet with its own headers and a WBS column', () => {
    const r = fromCsv('WBS,Name,Duration,Predecessors,Status\n1,Phase,,,\n1.1,A,3d,,Done\n1.2,B,2,2,in progress\n');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => [x.name, x.parent, x.duration, x.status])).toEqual([
      ['Phase', null, 1, 'todo'], ['A', 1, 3, 'done'], ['B', 1, 2, 'in_progress'],
    ]);
    expect(r.rows[2].predecessors).toEqual([{ row: 2, lag: 0, type: 'FS' }]);
  });

  it('says what is wrong instead of guessing', () => {
    expect(fromCsv('Name\n').ok).toBe(false);
    expect(fromCsv('Days\n3\n').ok).toBe(false);
    const bad = fromCsv('Name,Days\nA,x\n');
    expect(bad.ok ? '' : bad.error).toMatch(/Row 1/);
  });
});

describe('MS Project XML', () => {
  it('round-trips the outline, durations, link types, lags and progress', () => {
    const xml = toMspdi({ ...plan, projectName: 'Pay & go', projectStart: '2026-03-02' });
    expect(xml).toContain('<Name>Pay &amp; go</Name>');
    const back = fromMspdi(xml);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => [r.name, r.parent, r.duration, r.progress])).toEqual([
      ['Build', null, 1, null], ['Code, "fast"', 1, 3, null], ['Test', 1, 2, 40], ['Ship', null, 0, null],
    ]);
    expect(back.rows[2].predecessors).toEqual([{ row: 2, lag: 1, type: 'SS' }]);
  });

  it('skips the project summary row and reads outline levels', () => {
    const xml = `<Project><Tasks>
      <Task><UID>0</UID><Name>Whole project</Name><OutlineLevel>0</OutlineLevel></Task>
      <Task><UID>7</UID><Name>Phase</Name><OutlineLevel>1</OutlineLevel></Task>
      <Task><UID>8</UID><Name>Work</Name><OutlineLevel>2</OutlineLevel><Duration>PT16H0M0S</Duration></Task>
      <Task><UID>9</UID><Name>Next</Name><OutlineLevel>1</OutlineLevel><Duration>PT8H0M0S</Duration>
        <PredecessorLink><PredecessorUID>8</PredecessorUID><Type>2</Type><LinkLag>0</LinkLag></PredecessorLink></Task>
    </Tasks></Project>`;
    const r = fromMspdi(xml);
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => [x.name, x.parent, x.duration])).toEqual([['Phase', null, 1], ['Work', 1, 2], ['Next', null, 1]]);
    expect(r.rows[2].predecessors).toEqual([{ row: 2, lag: 0, type: 'FS' }]);
    expect(r.warnings[0]).toMatch(/start-to-finish/);
  });
});
