import type { TaskDependency } from '../shared/types.ts';

/**
 * Layout for the network diagram: activity-on-node, left to right.
 *
 * Columns are the longest chain of predecessors behind a task, so every arrow
 * points right. Within a column, rows are ordered by barycentre sweeps (a node
 * sits near the average row of its neighbours), a fixed number of times, which
 * untangles most crossings in plans of this size. With environment lanes on,
 * each task stays in its column but moves into its environment's band.
 *
 * Every loop here is bounded by the node count or a fixed sweep count; see the
 * bounded-loops rule in CLAUDE.md.
 */

export const NODE_W = 184;
export const NODE_H = 66;
export const COL_GAP = 64;
export const ROW_GAP = 22;
export const LANE_PAD = 14;
const SWEEPS = 6;

export type LayoutTask = { id: number; environment_id: number | null; start: string };
export type LayoutLane = { id: number | null; name: string };

export type NodeBox = { id: number; x: number; y: number; col: number; lane: number };
export type EdgePath = { from: number; to: number; points: [number, number][] };
export type LaneBand = { id: number | null; name: string; y: number; height: number };

export type NetworkLayout = {
  nodes: Map<number, NodeBox>;
  edges: EdgePath[];
  lanes: LaneBand[];
  width: number;
  height: number;
  columns: number;
};

/**
 * `order` must be a topological order (the schedule's). `lanes`, when given,
 * turns on environment bands in that order; tasks with no environment go in the
 * lane whose id is null, which the caller puts last.
 */
export function layoutNetwork(
  tasks: readonly LayoutTask[],
  deps: readonly TaskDependency[],
  order: readonly number[],
  lanes?: readonly LayoutLane[],
): NetworkLayout {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = order.filter((id) => byId.has(id));
  const live = deps.filter((d) => byId.has(d.predecessor_id) && byId.has(d.successor_id));

  const preds = new Map<number, number[]>();
  const succs = new Map<number, number[]>();
  for (const d of live) {
    (preds.get(d.successor_id) ?? preds.set(d.successor_id, []).get(d.successor_id)!).push(d.predecessor_id);
    (succs.get(d.predecessor_id) ?? succs.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d.successor_id);
  }

  // Longest-path rank. One pass is enough because `ids` is topologically ordered.
  const col = new Map<number, number>();
  for (const id of ids) {
    let c = 0;
    for (const p of preds.get(id) ?? []) c = Math.max(c, (col.get(p) ?? 0) + 1);
    col.set(id, c);
  }
  const columns = ids.length ? Math.max(...col.values()) + 1 : 0;

  const laneIndex = (id: number): number => {
    if (!lanes) return 0;
    const env = byId.get(id)!.environment_id;
    const i = lanes.findIndex((l) => l.id === env);
    return i >= 0 ? i : lanes.findIndex((l) => l.id == null);
  };

  // Initial order: by lane, then schedule, then id, so the first draw already reads in time.
  const cols: number[][] = Array.from({ length: columns }, () => []);
  for (const id of ids) cols[col.get(id)!].push(id);
  for (const c of cols) {
    c.sort((a, b) => laneIndex(a) - laneIndex(b) || byId.get(a)!.start.localeCompare(byId.get(b)!.start) || a - b);
  }

  const pos = new Map<number, number>();
  const index = () => cols.forEach((c) => c.forEach((id, i) => pos.set(id, i)));
  index();

  const bary = (id: number, neighbours: Map<number, number[]>) => {
    const ns = neighbours.get(id) ?? [];
    return ns.length ? ns.reduce((s, n) => s + pos.get(n)!, 0) / ns.length : pos.get(id)!;
  };

  for (let sweep = 0; sweep < SWEEPS; sweep++) {
    const forward = sweep % 2 === 0;
    const range = forward ? cols.slice(1) : cols.slice(0, -1).reverse();
    for (const c of range) {
      const score = new Map(c.map((id) => [id, bary(id, forward ? preds : succs)]));
      // Lanes stay grouped; the sweep only reorders inside each one.
      c.sort((a, b) => laneIndex(a) - laneIndex(b) || score.get(a)! - score.get(b)! || a - b);
      c.forEach((id, i) => pos.set(id, i));
    }
  }

  const strideY = NODE_H + ROW_GAP;
  const strideX = NODE_W + COL_GAP;
  const nodes = new Map<number, NodeBox>();
  let bands: LaneBand[] = [];
  let height = 0;

  if (lanes) {
    // Each band is as tall as its busiest column.
    const counts = lanes.map((_, li) => Math.max(0, ...cols.map((c) => c.filter((id) => laneIndex(id) === li).length)));
    let y = 0;
    bands = lanes.map((l, li) => {
      const h = Math.max(1, counts[li]) * strideY - ROW_GAP + LANE_PAD * 2;
      const band = { id: l.id, name: l.name, y, height: h };
      y += h;
      return band;
    });
    height = y;
    for (let ci = 0; ci < cols.length; ci++) {
      const seen = new Map<number, number>();
      for (const id of cols[ci]) {
        const li = laneIndex(id);
        const k = seen.get(li) ?? 0;
        seen.set(li, k + 1);
        nodes.set(id, { id, col: ci, lane: li, x: ci * strideX, y: bands[li].y + LANE_PAD + k * strideY });
      }
    }
  } else {
    const tallest = Math.max(0, ...cols.map((c) => c.length));
    height = tallest ? tallest * strideY - ROW_GAP : 0;
    for (let ci = 0; ci < cols.length; ci++) {
      // Short columns sit centred against the tallest, so chains read as a line.
      const offset = ((tallest - cols[ci].length) * strideY) / 2;
      cols[ci].forEach((id, i) => nodes.set(id, { id, col: ci, lane: 0, x: ci * strideX, y: offset + i * strideY }));
    }
  }

  const edges: EdgePath[] = live.map((d) => {
    const a = nodes.get(d.predecessor_id)!;
    const b = nodes.get(d.successor_id)!;
    const x1 = a.x + NODE_W;
    const y1 = a.y + NODE_H / 2;
    const x2 = b.x;
    const y2 = b.y + NODE_H / 2;
    // Turn in the gutter just after the source, so the vertical run never crosses a node.
    const mid = x1 + COL_GAP / 2;
    const points: [number, number][] = y1 === y2 ? [[x1, y1], [x2, y2]] : [[x1, y1], [mid, y1], [mid, y2], [x2, y2]];
    return { from: d.predecessor_id, to: d.successor_id, points };
  });

  return {
    nodes,
    edges,
    lanes: bands,
    width: columns ? columns * strideX - COL_GAP : 0,
    height,
    columns,
  };
}

/** An SVG path through orthogonal points, with the elbows rounded. */
export function roundedPath(points: readonly [number, number][], radius = 8): string {
  if (points.length < 2) return '';
  let d = `M${points[0][0]},${points[0][1]}`;
  for (let i = 1; i < points.length - 1; i++) {
    const [px, py] = points[i - 1];
    const [x, y] = points[i];
    const [nx, ny] = points[i + 1];
    const r = Math.min(radius, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const inX = x - Math.sign(x - px) * r;
    const inY = y - Math.sign(y - py) * r;
    const outX = x + Math.sign(nx - x) * r;
    const outY = y + Math.sign(ny - y) * r;
    d += ` L${inX},${inY} Q${x},${y} ${outX},${outY}`;
  }
  const last = points[points.length - 1];
  return `${d} L${last[0]},${last[1]}`;
}
