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
    expect(csv.split('\r\n')[3].startsWith('12,1.2,Test,40,,2,,,7SS+1,')).toBe(true);
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

describe('best and worst case', () => {
  const ranged = tasks.map((t) => (t.id === 11 ? { ...t, duration_low: 2, duration_high: 6 } : t));

  it('round-trip through CSV, and a summary writes none', () => {
    const csv = toCsv({ ...plan, tasks: ranged });
    expect(csv.split('\r\n')[0]).toContain('Days,Best,Worst,After');
    const back = fromCsv(csv);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => [r.duration_low ?? null, r.duration_high ?? null])).toEqual([[null, null], [2, 6], [null, null], [null, null]]);
  });

  it('read optimistic and pessimistic columns, and refuse a range that misses the duration', () => {
    const r = fromCsv('Name,Days,Optimistic,Pessimistic\nA,5,4,9\n');
    if (!r.ok) throw new Error(r.error);
    expect([r.rows[0].duration_low, r.rows[0].duration_high]).toEqual([4, 9]);
    const bad = fromCsv('Name,Days,Best\nA,5,7\n');
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toMatch(/Best case/);
  });

  it('round-trip through MS Project XML as Duration1 and Duration3', () => {
    const xml = toMspdi({ ...plan, tasks: ranged, projectName: 'P', projectStart: '2026-03-02' });
    expect(xml).toContain('<Alias>Best</Alias>');
    const back = fromMspdi(xml);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => [r.duration_low ?? null, r.duration_high ?? null])).toEqual([[null, null], [2, 6], [null, null], [null, null]]);
    expect(toMspdi({ ...plan, projectName: 'P', projectStart: null })).not.toContain('ExtendedAttribute');
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

describe('deadlines in files', () => {
  const due = tasks.map((t) => (t.id === 12 ? { ...t, deadline: '2026-03-06' } : t.id === 10 ? { ...t, deadline: '2026-03-13' } : t));

  it('round-trip through CSV, beside Finish', () => {
    const csv = toCsv({ ...plan, tasks: due });
    expect(csv.split('\r\n')[0]).toContain('Start,Finish,Deadline,Float');
    const back = fromCsv(csv);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => r.deadline)).toEqual(['2026-03-13', null, '2026-03-06', null]);
  });

  it('read a Due column, and leave out what is not a date, saying so', () => {
    const r = fromCsv('Task,Days,Due\nA,2,2026-04-01\nB,1,next week\n');
    if (!r.ok) throw new Error(r.error);
    expect(r.rows.map((x) => x.deadline)).toEqual(['2026-04-01', null]);
    expect(r.warnings).toEqual(['Row 2: deadline “next week” is not a YYYY-MM-DD date, so it was left out']);
  });

  it('round-trip through MS Project XML as <Deadline>', () => {
    const xml = toMspdi({ ...plan, tasks: due, projectName: 'P', projectStart: '2026-03-02' });
    expect(xml).toContain('<Deadline>2026-03-06T17:00:00</Deadline>');
    const back = fromMspdi(xml);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => r.deadline)).toEqual(['2026-03-13', null, '2026-03-06', null]);
  });
});
