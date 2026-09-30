import { describe, expect, it } from 'vitest';
import {
  applyResourcePick, formatResources, nearMatch, parseResources, RESOURCES_PER_TASK_MAX, resourceKey, resourceSuggestions,
} from '../shared/resources.ts';
import { fromCsv, fromMspdi, toCsv, toMspdi } from '../client/planIO.ts';
import { outline } from '../shared/wbs.ts';
import type { Resource, Task } from '../shared/types.ts';

const people: Resource[] = [
  { id: 1, name: 'Mai', active: 1 },
  { id: 2, name: 'Tuan', active: 1 },
  { id: 3, name: 'Lan Pham', active: 1 },
  { id: 4, name: 'Old Hand', active: 0 },
];

describe('the Who column', () => {
  it('splits on commas and semicolons only, so names keep their spaces', () => {
    expect(parseResources(' Mai ,  Lan   Pham;Tuan ,, ')).toEqual({ ok: true, names: ['Mai', 'Lan Pham', 'Tuan'] });
    expect(parseResources('')).toEqual({ ok: true, names: [] });
    expect(parseResources(null)).toEqual({ ok: true, names: [] });
  });

  it('drops repeats ignoring case, keeping the first spelling and the order', () => {
    expect(parseResources('Tuan, mai, TUAN, Mai')).toEqual({ ok: true, names: ['Tuan', 'mai'] });
  });

  it('matches case but not accents: Tuan and Tuấn are two keys', () => {
    expect(resourceKey('  TUAN ')).toBe(resourceKey('tuan'));
    expect(resourceKey('Tuấn')).not.toBe(resourceKey('Tuan'));
    // Composed and decomposed forms of the same letters are one person.
    expect(resourceKey('Tuấn')).toBe(resourceKey('Tuấn'));
  });

  it('refuses brackets, so Mai[50%] stays free for allocation later', () => {
    const r = parseResources('Mai[50%]');
    expect(r.ok).toBe(false);
  });

  it('limits the length of a name and the number on a task', () => {
    expect(parseResources('x'.repeat(61)).ok).toBe(false);
    const many = Array.from({ length: RESOURCES_PER_TASK_MAX + 1 }, (_, i) => `P${i}`).join(',');
    expect(parseResources(many).ok).toBe(false);
  });

  it('formats in the order typed and skips anyone unknown', () => {
    const byId = new Map(people.map((p) => [p.id, p]));
    expect(formatResources([2, 1, 99], byId)).toBe('Tuan, Mai');
    expect(formatResources(undefined, byId)).toBe('');
  });
});

describe('suggestions', () => {
  it('offers known people for the name under the caret, leaving out those listed and inactive', () => {
    const text = 'Mai, t';
    const found = resourceSuggestions(text, text.length, people);
    expect(found.items[0]).toEqual({ kind: 'new', name: 't', near: null });
    const names = found.items.filter((i) => i.kind === 'known').map((i) => (i.kind === 'known' ? i.resource.name : ''));
    expect(names).toEqual(['Tuan']);
    expect(text.slice(found.from, found.to)).toBe('t');
  });

  it('offers nothing new when the name is already someone, ignoring case', () => {
    const found = resourceSuggestions('tuan', 4, people);
    expect(found.items.every((i) => i.kind === 'known')).toBe(true);
  });

  it('puts the likely person first when a new name is a slip for them', () => {
    expect(nearMatch('Tuấn', people)?.name).toBe('Tuan');
    expect(nearMatch('Tuab', people)?.name).toBe('Tuan');
    expect(nearMatch('Lan Phạm', people)?.name).toBe('Lan Pham');
    expect(nearMatch('Khoa', people)).toBeNull();
    expect(nearMatch('tuan', people)).toBeNull();
    const found = resourceSuggestions('Tuấn', 4, people);
    expect(found.items[0]).toMatchObject({ kind: 'known', resource: { name: 'Tuan' } });
    expect(found.items[1]).toMatchObject({ kind: 'new', name: 'Tuấn' });
  });

  it('replaces the name picked and leaves a comma for the next', () => {
    const text = 'Mai, tu, Lan Pham';
    const found = resourceSuggestions(text, 7, people);
    expect(applyResourcePick(text, found.from, found.to, 'Tuan')).toEqual({ text: 'Mai, Tuan, Lan Pham', caret: 11 });
    expect(applyResourcePick('ma', 0, 2, 'Mai')).toEqual({ text: 'Mai, ', caret: 5 });
  });
});

describe('people in files', () => {
  function task(id: number, name: string, resource_ids: number[]): Task {
    return {
      id, project_id: 1, environment_id: null, name, duration: 2, status: 'todo', not_before: null, note: null,
      sort_order: id, actual_start: null, actual_end: null, start_date: null, end_date: null, total_float: null, critical: 0,
      resource_ids,
    };
  }
  const tasks = [task(1, 'Build', [2, 1]), task(2, 'Test', []), task(3, 'Ship', [3])];
  const plan = { tasks, outline: outline(tasks), schedule: new Map(), deps: [], environments: [], resources: people };

  it('round-trips through CSV as the Who text', () => {
    const csv = toCsv(plan);
    expect(csv.split('\r\n')[0]).toContain(',Resources,');
    expect(csv).toContain('"Tuan, Mai"');
    const back = fromCsv(csv);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => r.resources)).toEqual(['Tuan, Mai', null, 'Lan Pham']);
  });

  it('reads an older CSV whose column is Assignee', () => {
    const back = fromCsv('Task,Assignee\nA,"Mai, Tuan"\n');
    if (!back.ok) throw new Error(back.error);
    expect(back.rows[0].resources).toBe('Mai, Tuan');
  });

  it('round-trips through MS Project XML as Resources and Assignments', () => {
    const xml = toMspdi({ ...plan, projectName: 'P', projectStart: null });
    expect(xml).toContain('<Resources>');
    expect((xml.match(/<Assignment>/g) ?? []).length).toBe(3);
    const back = fromMspdi(xml);
    if (!back.ok) throw new Error(back.error);
    expect(back.rows.map((r) => r.resources)).toEqual(['Tuan, Mai', null, 'Lan Pham']);
  });
});
