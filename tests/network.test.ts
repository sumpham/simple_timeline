import { describe, expect, it } from 'vitest';
import { layoutNetwork, NODE_H, NODE_W, roundedPath, type LayoutTask } from '../client/network.ts';
import type { TaskDependency } from '../shared/types.ts';

const t = (id: number, environment_id: number | null = null): LayoutTask => ({ id, environment_id, start: '2026-03-02' });
const dep = (a: number, b: number): TaskDependency => ({ predecessor_id: a, successor_id: b, lag: 0 });

function overlaps(layout: ReturnType<typeof layoutNetwork>) {
  const boxes = [...layout.nodes.values()];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + NODE_W && b.x < a.x + NODE_W && a.y < b.y + NODE_H && b.y < a.y + NODE_H) return true;
    }
  }
  return false;
}

describe('layoutNetwork', () => {
  it('ranks columns by the longest chain behind each task', () => {
    const l = layoutNetwork([t(1), t(2), t(3), t(4)], [dep(1, 2), dep(2, 4), dep(1, 3), dep(3, 4)], [1, 2, 3, 4]);
    expect([1, 2, 3, 4].map((id) => l.nodes.get(id)!.col)).toEqual([0, 1, 1, 2]);
    expect(l.columns).toBe(3);
    expect(overlaps(l)).toBe(false);
  });

  it('points every arrow to the right', () => {
    const deps = [dep(1, 3), dep(2, 3), dep(3, 5), dep(1, 4), dep(4, 5)];
    const l = layoutNetwork([1, 2, 3, 4, 5].map((id) => t(id)), deps, [1, 2, 3, 4, 5]);
    for (const e of l.edges) expect(e.points[e.points.length - 1][0]).toBeGreaterThan(e.points[0][0]);
  });

  it('puts each task inside its environment lane', () => {
    const lanes = [{ id: 10, name: 'SIT' }, { id: 11, name: 'UAT' }, { id: null, name: 'No environment' }];
    const l = layoutNetwork([t(1, 10), t(2, 11), t(3, null), t(4, 10)], [dep(1, 2), dep(1, 3), dep(2, 4)], [1, 2, 3, 4], lanes);
    for (const n of l.nodes.values()) {
      const band = l.lanes[n.lane];
      expect(n.y).toBeGreaterThanOrEqual(band.y);
      expect(n.y + NODE_H).toBeLessThanOrEqual(band.y + band.height);
    }
    expect(l.nodes.get(3)!.lane).toBe(2);
    expect(overlaps(l)).toBe(false);
  });

  it('finishes on long chains and wide fans', () => {
    const chain = Array.from({ length: 400 }, (_, i) => t(i + 1));
    const chainDeps = chain.slice(1).map((x) => dep(x.id - 1, x.id));
    expect(layoutNetwork(chain, chainDeps, chain.map((x) => x.id)).columns).toBe(400);

    const fan = Array.from({ length: 300 }, (_, i) => t(i + 2));
    const fanDeps = fan.map((x) => dep(1, x.id));
    const l = layoutNetwork([t(1), ...fan], fanDeps, [1, ...fan.map((x) => x.id)]);
    expect(l.columns).toBe(2);
    expect(overlaps(l)).toBe(false);
  });

  it('handles an empty plan', () => {
    expect(layoutNetwork([], [], [])).toMatchObject({ width: 0, height: 0, columns: 0 });
  });
});

/** Every way a drawing can mislead: a line through a box, or two unrelated arrows on one line. */
function misleading(layout: ReturnType<typeof layoutNetwork>): string[] {
  const problems: string[] = [];
  const segs = layout.edges.flatMap((e) => e.points.slice(1).map((p, i) => ({ e, a: e.points[i], b: p })));
  for (const { e, a, b } of segs) {
    for (const n of layout.nodes.values()) {
      if (n.id === e.from || n.id === e.to) continue;
      const [x1, x2] = [Math.min(a[0], b[0]), Math.max(a[0], b[0])];
      const [y1, y2] = [Math.min(a[1], b[1]), Math.max(a[1], b[1])];
      if (x2 > n.x && x1 < n.x + NODE_W && y2 > n.y && y1 < n.y + NODE_H) problems.push(`${e.from}->${e.to} crosses box ${n.id}`);
    }
  }
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i];
      const q = segs[j];
      if (p.e === q.e || p.e.from === q.e.from || p.e.to === q.e.to) continue;
      const horiz = p.a[1] === p.b[1] && q.a[1] === q.b[1] && p.a[1] === q.a[1];
      const vert = p.a[0] === p.b[0] && q.a[0] === q.b[0] && p.a[0] === q.a[0];
      if (!horiz && !vert) continue;
      const axis = horiz ? 0 : 1;
      const lo = Math.max(Math.min(p.a[axis], p.b[axis]), Math.min(q.a[axis], q.b[axis]));
      const hi = Math.min(Math.max(p.a[axis], p.b[axis]), Math.max(q.a[axis], q.b[axis]));
      if (hi - lo > 1) problems.push(`${p.e.from}->${p.e.to} overlaps ${q.e.from}->${q.e.to}`);
    }
  }
  return problems;
}

describe('edge routing', () => {
  // The plan that looked wrong: SIT Deployment (12) waits on rows 1, 2, 3 and 5, and
  // the arrow from row 1 used to run through the onboarding boxes in between.
  const ids = Array.from({ length: 16 }, (_, i) => i + 1);
  const deps = [
    dep(6, 4), dep(4, 5), dep(6, 10), dep(6, 11),
    dep(1, 12), dep(2, 12), dep(3, 12), dep(5, 12),
    dep(12, 14), dep(14, 13), dep(13, 15), dep(14, 15), dep(15, 16),
  ];
  const order = [1, 2, 3, 6, 7, 8, 9, 4, 10, 11, 5, 12, 14, 13, 15, 16];

  it('never draws through a box or puts unrelated arrows on one line', () => {
    const l = layoutNetwork(ids.map((id) => t(id)), deps, order);
    expect(misleading(l)).toEqual([]);
  });

  it('holds with environment lanes too', () => {
    const env = (id: number) => (id === 6 || id === 7 ? null : id === 10 || id === 13 || id === 15 ? 11 : id === 11 || id === 16 ? 12 : 10);
    const lanes = [{ id: 10, name: 'SIT' }, { id: 11, name: 'UAT' }, { id: 12, name: 'PROD' }, { id: null, name: 'No environment' }];
    const l = layoutNetwork(ids.map((id) => t(id, env(id))), deps, order, lanes);
    expect(misleading(l)).toEqual([]);
  });

  it('holds on random plans', () => {
    // A small deterministic generator, so a failure reproduces.
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 40; run++) {
      const n = 6 + Math.floor(rnd() * 18);
      const ds: TaskDependency[] = [];
      for (let b = 2; b <= n; b++) {
        for (let a = 1; a < b; a++) if (rnd() < 0.18) ds.push(dep(a, b));
      }
      const tasks = Array.from({ length: n }, (_, i) => t(i + 1));
      const l = layoutNetwork(tasks, ds, tasks.map((x) => x.id));
      expect(misleading(l), `run ${run}`).toEqual([]);
    }
  });
});

describe('roundedPath', () => {
  it('rounds elbows and keeps straight runs straight', () => {
    expect(roundedPath([[0, 0], [10, 0]])).toBe('M0,0 L10,0');
    expect(roundedPath([[0, 0], [20, 0], [20, 20], [40, 20]], 4)).toBe('M0,0 L16,0 Q20,0 20,4 L20,16 Q20,20 24,20 L40,20');
  });
});
