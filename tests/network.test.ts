import { describe, expect, it } from 'vitest';
import { anchoredScroll, edgeKey, fitZoom, layoutNetwork, manualPoints, NET_ZOOM_DEFAULT, NET_ZOOMS, NODE_H, NODE_W, roundedPath, routeOf, STUB, type LayoutTask } from '../client/network.ts';
import type { TaskDependency } from '../shared/types.ts';
import { misleading, overlaps } from './networkCheck.ts';

const t = (id: number, environment_id: number | null = null): LayoutTask => ({ id, environment_id, start: '2026-03-02' });
const dep = (a: number, b: number): TaskDependency => ({ predecessor_id: a, successor_id: b, lag: 0 });


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

describe('hand arrangement', () => {
  const tasks = [t(1), t(2), t(3)];
  const deps = [dep(1, 2), dep(2, 3)];

  it('puts a dragged box where it was dropped and redraws only its arrows', () => {
    const auto = layoutNetwork(tasks, deps, [1, 2, 3]);
    const l = layoutNetwork(tasks, deps, [1, 2, 3], undefined, { positions: new Map([[3, { x: 900, y: 400 }]]) });
    expect(l.nodes.get(3)).toMatchObject({ x: 900, y: 400 });
    expect(l.edges.find((e) => e.to === 2)!.points).toEqual(auto.edges.find((e) => e.to === 2)!.points);
    const into3 = l.edges.find((e) => e.to === 3)!.points;
    expect(into3[into3.length - 1]).toEqual([900, 400 + NODE_H / 2 + 6]);
    expect(l.width).toBeGreaterThanOrEqual(900 + NODE_W);
    expect(l.height).toBeGreaterThanOrEqual(400 + NODE_H);
  });

  it('draws a shaped arrow from its route, and reads the same route back', () => {
    const route = { out: 30, y: 250, in: 20 };
    const l = layoutNetwork(tasks, deps, [1, 2, 3], undefined, { routes: new Map([[edgeKey(1, 2), route]]) });
    const e = l.edges.find((x) => x.to === 2)!;
    expect(e.points).toHaveLength(6);
    expect(routeOf(e.points, l.nodes.get(1)!, l.nodes.get(2)!)).toEqual(route);
  });

  it('goes round when the target is dragged to the left of its source', () => {
    const pts = manualPoints({ x: 500, y: 0 }, { x: 0, y: 200 }, null);
    expect(pts[0][0]).toBe(500 + NODE_W);
    expect(pts[1][0]).toBe(500 + NODE_W + STUB);
    expect(pts[pts.length - 1][0]).toBe(0);
    // Underneath both boxes, so the way round never crosses them.
    expect(pts[2][1]).toBeGreaterThan(200 + NODE_H);
  });

  it('reads the router\u2019s own arrows as routes', () => {
    const l = layoutNetwork(tasks, deps, [1, 2, 3]);
    for (const e of l.edges) {
      const r = routeOf(e.points, l.nodes.get(e.from)!, l.nodes.get(e.to)!);
      expect(r.out).toBeGreaterThan(0);
    }
  });
});

describe('roundedPath', () => {
  it('rounds elbows and keeps straight runs straight', () => {
    expect(roundedPath([[0, 0], [10, 0]])).toBe('M0,0 L10,0');
    expect(roundedPath([[0, 0], [20, 0], [20, 20], [40, 20]], 4)).toBe('M0,0 L16,0 Q20,0 20,4 L20,16 Q20,20 24,20 L40,20');
  });
});

describe('network zoom', () => {
  it('starts at 100% and runs in ascending steps', () => {
    expect(NET_ZOOMS[NET_ZOOM_DEFAULT]).toBe(1);
    for (let i = 1; i < NET_ZOOMS.length; i++) expect(NET_ZOOMS[i]).toBeGreaterThan(NET_ZOOMS[i - 1]);
  });

  it('fits the larger of the two dimensions', () => {
    expect(NET_ZOOMS[fitZoom(1000, 400, 1000, 1000)]).toBe(1);
    expect(NET_ZOOMS[fitZoom(400, 2000, 1000, 1000)]).toBe(0.5);
    expect(NET_ZOOMS[fitZoom(200, 100, 1000, 1000)]).toBe(2);
    // Too big for any step: the smallest one, never an out-of-range index.
    expect(fitZoom(100_000, 100, 1000, 1000)).toBe(0);
    expect(fitZoom(0, 0, 1000, 1000)).toBe(NET_ZOOMS.length - 1);
  });

  it('keeps the point under the pointer still', () => {
    // The point 300px into the view, scrolled 200px, sits at 500 at scale 1.
    const scroll = anchoredScroll(200, 300, 1, 2);
    expect((scroll + 300) / 2).toBe(500);
    expect(anchoredScroll(0, 0, 1, 0.5)).toBe(0);
    // Zooming out near the left edge clamps at zero, as the browser would.
    expect(anchoredScroll(10, 300, 1, 0.5)).toBe(0);
  });
});
