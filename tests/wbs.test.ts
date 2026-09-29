import { describe, expect, it } from 'vitest';
import { descendants, indent, leavesOf, moveAmongSiblings, outdent, outline, type OutlinePlacement } from '../shared/wbs.ts';

type N = { id: number; sort_order: number; parent_id?: number | null };
const apply = (tasks: N[], p: OutlinePlacement[] | null): N[] => {
  if (!p) throw new Error('no change');
  const by = new Map(p.map((x) => [x.id, x]));
  return tasks.map((t) => (by.has(t.id) ? { ...t, ...by.get(t.id)! } : t));
};
const flat = (n: number): N[] => Array.from({ length: n }, (_, i) => ({ id: i + 1, sort_order: i }));

describe('outline', () => {
  it('numbers depth-first whatever the stored order', () => {
    const tasks: N[] = [{ id: 1, sort_order: 0 }, { id: 3, sort_order: 0, parent_id: 1 }, { id: 2, sort_order: 1 }, { id: 4, sort_order: 1, parent_id: 1 }];
    expect(outline(tasks).map((r) => [r.id, r.wbs, r.depth, r.summary])).toEqual([
      [1, '1', 0, true], [3, '1.1', 1, false], [4, '1.2', 1, false], [2, '2', 0, false],
    ]);
  });

  it('puts a task in a parent loop back at the top instead of losing it', () => {
    const rows = outline([{ id: 1, sort_order: 0, parent_id: 2 }, { id: 2, sort_order: 1, parent_id: 1 }]);
    expect(rows.map((r) => r.id).sort()).toEqual([1, 2]);
  });
});

describe('indent and outdent', () => {
  it('indents under the sibling above, and outdents back after it', () => {
    let t = apply(flat(3), indent(flat(3), 2));
    expect(outline(t).map((r) => r.wbs)).toEqual(['1', '1.1', '2']);
    t = apply(t, indent(t, 3));
    expect(outline(t).map((r) => [r.id, r.wbs])).toEqual([[1, '1'], [2, '1.1'], [3, '1.2']]);
    t = apply(t, outdent(t, 2));
    expect(outline(t).map((r) => [r.id, r.wbs])).toEqual([[1, '1'], [3, '1.1'], [2, '2']]);
  });

  it('refuses to indent the first of its siblings', () => {
    expect(indent(flat(2), 1)).toBeNull();
    expect(outdent(flat(2), 1)).toBeNull();
  });

  it('moves a summary with everything under it', () => {
    let t = apply(flat(3), indent(flat(3), 2));
    t = apply(t, moveAmongSiblings(t, 1, 1));
    expect(outline(t).map((r) => r.id)).toEqual([3, 1, 2]);
  });

  it('finds everything under a summary and the working tasks among them', () => {
    let t = apply(flat(4), indent(flat(4), 2));
    t = apply(t, indent(t, 3));
    t = apply(t, indent(t, 3));
    expect([...descendants(t, 1)].sort()).toEqual([2, 3]);
    expect(leavesOf(t, 1)).toEqual([3]);
  });
});
