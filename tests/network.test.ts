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

describe('roundedPath', () => {
  it('rounds elbows and keeps straight runs straight', () => {
    expect(roundedPath([[0, 0], [10, 0]])).toBe('M0,0 L10,0');
    expect(roundedPath([[0, 0], [20, 0], [20, 20], [40, 20]], 4)).toBe('M0,0 L16,0 Q20,0 20,4 L20,16 Q20,20 24,20 L40,20');
  });
});
