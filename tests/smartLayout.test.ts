import { describe, expect, it } from 'vitest';
import { layoutNetwork, NODE_H, ROW_GAP, type LayoutTask } from '../client/network.ts';
import { smartArrange, type ArrangeTask } from '../client/smartLayout.ts';
import type { TaskDependency } from '../shared/types.ts';
import { misleading, overlaps } from './networkCheck.ts';

const dep = (a: number, b: number): TaskDependency => ({ predecessor_id: a, successor_id: b, lag: 0 });
const task = (id: number, critical = false): ArrangeTask => ({ id, start: '2026-03-02', critical });

/** Draw an arrangement exactly as the diagram does: as hand overrides on the automatic layout. */
function draw(tasks: ArrangeTask[], deps: TaskDependency[], order: number[]) {
  const a = smartArrange(tasks, deps, order);
  const layoutTasks: LayoutTask[] = tasks.map((t) => ({ id: t.id, environment_id: null, start: t.start }));
  return { a, l: layoutNetwork(layoutTasks, deps, order, undefined, a) };
}

/**
 * Wherever an arrow turns, every arrow touching that point must share one source
 * or one target; anything else reads as a junction that is not there.
 */
function falseJunctions(l: ReturnType<typeof layoutNetwork>): string[] {
  const out: string[] = [];
  const touches = (f: (typeof l.edges)[number], [x, y]: [number, number]) => f.points.some((a, k) => {
    const b = f.points[k + 1];
    if (!b) return false;
    return (a[1] === b[1] && a[1] === y && Math.min(a[0], b[0]) <= x && x <= Math.max(a[0], b[0]))
      || (a[0] === b[0] && a[0] === x && Math.min(a[1], b[1]) <= y && y <= Math.max(a[1], b[1]));
  });
  for (const e of l.edges) {
    for (let i = 1; i < e.points.length - 1; i++) {
      const at = l.edges.filter((f) => touches(f, e.points[i]));
      const oneSource = at.every((f) => f.from === at[0].from);
      const oneTarget = at.every((f) => f.to === at[0].to);
      if (!oneSource && !oneTarget) out.push(`junction at ${e.points[i]} joins ${at.map((f) => `${f.from}->${f.to}`).join(', ')}`);
    }
  }
  return out;
}

// The plan from the screenshot that prompted this: many start tasks feeding SIT
// Deployment, an onboarding fan-out from SoAc, and a long arrow into go-live.
const names = {
  1: 'Build context base tool', 2: 'Enhance Ms Teams Bot', 3: 'SoAc', 4: 'SIT ENV Onboarding',
  5: 'SIT Deployment #1', 6: 'Build core platform', 7: 'Build web admin portal', 8: 'Build working tools',
  9: 'K-DAI presentation', 10: 'SIT Deployment', 11: 'SIT Testing', 12: 'UAT ENV Onboarding',
  13: 'UAT Deployment', 14: 'UAT Testing', 15: 'PROD ENV Onboarding', 16: 'Go live',
};
const ids = Object.keys(names).map(Number);
const deps = [
  dep(1, 10), dep(2, 5), dep(3, 4), dep(4, 5), dep(5, 10), dep(6, 10), dep(7, 10), dep(8, 10),
  dep(3, 12), dep(3, 15), dep(10, 11), dep(11, 13), dep(11, 14), dep(12, 13), dep(13, 14), dep(14, 16), dep(15, 16),
];
const criticalIds = new Set([8, 10, 11, 13, 14, 16]);
const tasks = ids.map((id) => task(id, criticalIds.has(id)));
const order = [1, 2, 3, 6, 7, 8, 9, 4, 12, 15, 5, 10, 11, 13, 14, 16];

describe('smartArrange', () => {
  it('draws the plan that prompted it without a misleading line', () => {
    const { l } = draw(tasks, deps, order);
    expect(overlaps(l)).toBe(false);
    expect(misleading(l)).toEqual([]);
    expect(falseJunctions(l)).toEqual([]);
  });

  it('puts every box on a shared grid', () => {
    const { a } = draw(tasks, deps, order);
    const stride = NODE_H + ROW_GAP;
    for (const p of a.positions.values()) {
      expect(p.y % stride).toBe(0);
      expect(p.x % 8).toBe(0);
    }
  });

  it('runs the critical path as one straight line', () => {
    const { l } = draw(tasks, deps, order);
    const path = [8, 10, 11, 13, 14, 16];
    const ys = path.map((id) => l.nodes.get(id)!.y);
    expect(new Set(ys).size).toBe(1);
    for (let i = 1; i < path.length; i++) {
      const e = l.edges.find((x) => x.from === path[i - 1] && x.to === path[i])!;
      expect(e.points).toHaveLength(2);
    }
  });

  it('attaches arrows at three anchors per side', () => {
    const { a, l } = draw(tasks, deps, order);
    for (const e of l.edges) {
      const r = a.routes.get(`${e.from}-${e.to}`)!;
      const from = l.nodes.get(e.from)!;
      const to = l.nodes.get(e.to)!;
      expect(r.from).toBeDefined();
      expect([14, NODE_H / 2, NODE_H - 20]).toContain(e.points[0][1] - from.y);
      expect([20, NODE_H / 2, NODE_H - 14]).toContain(e.points[e.points.length - 1][1] - to.y);
    }
  });

  it('keeps level arrows straight', () => {
    const { l } = draw(tasks, deps, order);
    for (const e of l.edges) {
      const a = l.nodes.get(e.from)!;
      const b = l.nodes.get(e.to)!;
      if (a.y === b.y && e.points.every(([, y]) => y === e.points[0][1])) expect(e.points).toHaveLength(2);
    }
  });

  it('holds on random plans', () => {
    let seed = 11;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let run = 0; run < 60; run++) {
      const n = 4 + Math.floor(rnd() * 22);
      const ds: TaskDependency[] = [];
      for (let b = 2; b <= n; b++) {
        for (let a = 1; a < b; a++) if (rnd() < 0.16) ds.push(dep(a, b));
      }
      const ts = Array.from({ length: n }, (_, i) => task(i + 1, rnd() < 0.3));
      const { l } = draw(ts, ds, ts.map((x) => x.id));
      expect(overlaps(l), `run ${run}`).toBe(false);
      expect(misleading(l), `run ${run}`).toEqual([]);
      expect(falseJunctions(l), `run ${run}`).toEqual([]);
      for (const e of l.edges) expect(e.points[e.points.length - 1][0], `run ${run}`).toBeGreaterThan(e.points[0][0]);
    }
  });

  it('handles an empty plan and a lone task', () => {
    expect(smartArrange([], [], []).positions.size).toBe(0);
    expect(smartArrange([task(1)], [], [1]).positions.get(1)).toEqual({ x: 0, y: 0 });
  });
});
