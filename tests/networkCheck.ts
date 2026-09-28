import { layoutNetwork, NODE_H, NODE_W } from '../client/network.ts';

/** Shared checks for network drawings; not a test file itself. */

export function overlaps(layout: ReturnType<typeof layoutNetwork>) {
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

/** Every way a drawing can mislead: a line through a box, or two unrelated arrows on one line. */
export function misleading(layout: ReturnType<typeof layoutNetwork>): string[] {
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
