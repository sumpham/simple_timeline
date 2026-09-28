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
export const ROW_GAP = 30;
export const LANE_PAD = 14;
const SWEEPS = 6;

export type LayoutTask = { id: number; environment_id: number | null; start: string };
export type LayoutLane = { id: number | null; name: string };

export type NodeBox = { id: number; x: number; y: number; col: number; lane: number };
export type EdgePath = { from: number; to: number; points: [number, number][] };
export type LaneBand = { id: number | null; name: string; y: number; height: number };

/**
 * A hand-shaped arrow: how far right of its source the first vertical run sits,
 * the height of a detour (null: none, it runs at the target's height), and how far
 * left of its target the last vertical run sits. Offsets are relative to the boxes
 * so a shaped arrow keeps its shape when a box is dragged.
 */
export type Route = { out: number; y: number | null; in: number; from?: Anchor; to?: Anchor };

/**
 * Where on a box's side an arrow attaches: a quarter down, the middle, or three
 * quarters down. Without one, an arrow leaves just above the middle and arrives
 * just below it (the automatic router's ports). Outgoing and incoming quarter
 * anchors sit a few pixels apart, so a line leaving one box never lies on a line
 * arriving at a box level with it; the middle is kept for straight arrows.
 */
export type Anchor = 'top' | 'mid' | 'bottom';
const OUT_ANCHOR: Record<Anchor, number> = { top: 14, mid: NODE_H / 2, bottom: NODE_H - 20 };
const IN_ANCHOR: Record<Anchor, number> = { top: 20, mid: NODE_H / 2, bottom: NODE_H - 14 };
export const ANCHORS: readonly Anchor[] = ['top', 'mid', 'bottom'];

/** The height an arrow leaves (`out`) or reaches (`in`) a box at. */
export function anchorY(box: { y: number }, side: 'out' | 'in', anchor?: Anchor | null): number {
  if (anchor) return box.y + (side === 'out' ? OUT_ANCHOR : IN_ANCHOR)[anchor];
  return box.y + NODE_H / 2 + (side === 'out' ? -6 : 6);
}

export type LayoutOverrides = {
  /** Dragged boxes, by task id, in layout coordinates. */
  positions?: ReadonlyMap<number, { x: number; y: number }>;
  /** Hand-shaped arrows, by `edgeKey`. */
  routes?: ReadonlyMap<string, Route>;
};

export const edgeKey = (from: number, to: number) => `${from}-${to}`;

/** The stub an arrow keeps between a box and its first or last turn. */
export const STUB = 14;

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
  overrides: LayoutOverrides = {},
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
  const nodes = new Map<number, NodeBox>();
  let bands: LaneBand[] = [];
  let height = 0;

  // Rows first; x comes after routing, because a busy gutter is made wider.
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
        nodes.set(id, { id, col: ci, lane: li, x: 0, y: bands[li].y + LANE_PAD + k * strideY });
      }
    }
  } else {
    const tallest = Math.max(0, ...cols.map((c) => c.length));
    height = tallest ? tallest * strideY - ROW_GAP : 0;
    for (let ci = 0; ci < cols.length; ci++) {
      // Short columns sit centred against the tallest, so chains read as a line.
      const offset = Math.round(((tallest - cols[ci].length) * strideY) / 2);
      cols[ci].forEach((id, i) => nodes.set(id, { id, col: ci, lane: 0, x: 0, y: offset + i * strideY }));
    }
  }

  const { edges, colX } = routeEdges(live, nodes, cols);
  for (const n of nodes.values()) n.x = colX[n.col];

  // Hand arrangement goes on top: dragged boxes move, and any arrow that touches a
  // moved box or was shaped by hand is drawn from its route instead of the router's.
  const moved = new Set<number>();
  for (const [id, p] of overrides.positions ?? []) {
    const n = nodes.get(id);
    if (!n) continue;
    n.x = p.x;
    n.y = p.y;
    moved.add(id);
  }
  for (const e of edges) {
    const route = overrides.routes?.get(edgeKey(e.from, e.to));
    if (!route && !moved.has(e.from) && !moved.has(e.to)) continue;
    e.points = manualPoints(nodes.get(e.from)!, nodes.get(e.to)!, route ?? null);
  }

  // Channels above or below every node can reach past the edge; keep them on the canvas.
  let minY = 0;
  let maxY = height;
  for (const n of nodes.values()) maxY = Math.max(maxY, n.y + NODE_H);
  for (const e of edges) for (const [, y] of e.points) { minY = Math.min(minY, y - 8); maxY = Math.max(maxY, y + 8); }
  if (minY < 0) {
    for (const n of nodes.values()) n.y -= minY;
    for (const e of edges) e.points = e.points.map(([x, y]) => [x, y - minY]);
    bands = bands.map((b) => ({ ...b, y: b.y - minY }));
    if (bands.length) bands[0] = { ...bands[0], y: 0, height: bands[0].height - minY };
  }

  let width = columns ? colX[columns - 1] + NODE_W : 0;
  for (const n of nodes.values()) width = Math.max(width, n.x + NODE_W);
  for (const e of edges) for (const [x] of e.points) width = Math.max(width, x + 8);

  return {
    nodes,
    edges,
    lanes: bands,
    width,
    height: maxY - minY,
    columns,
  };
}

/** Gap between vertical tracks in a gutter, and between arrows sharing a channel. */
const TRACK = 10;
const CHANNEL_TRACK = 6;
/** Clearance an arrow keeps from a box it passes. */
const CLEAR = 5;
/**
 * Arrows leave a box this far above its middle and arrive this far below it, so a
 * line leaving one box can never lie on a line arriving at a box level with it.
 * An arrow between two level boxes stays straight, through the middle.
 */
const PORT = 6;

/**
 * Orthogonal routing that never lets two unrelated arrows share a line.
 *
 * - Every source gets its own vertical track in the gutter after it (its arrows
 *   fan out from there), and every target of a long arrow its own track in the
 *   gutter before it. Tracks never share an x, so vertical runs never overlap.
 * - An arrow that skips columns crosses them in a channel: the gap between two
 *   rows that is clear in every column it passes, or above or below everything.
 *   It never runs through a box. Arrows in one channel are spread apart.
 * - Lines may cross; only arrows with the same source or the same target may
 *   share a segment, and there the shared line means exactly that.
 */
function routeEdges(
  deps: readonly TaskDependency[],
  nodes: Map<number, NodeBox>,
  cols: number[][],
): { edges: EdgePath[]; colX: number[] } {
  const mid = (id: number) => nodes.get(id)!.y + NODE_H / 2;
  const outY = (id: number) => mid(id) - PORT;
  const inY = (id: number) => mid(id) + PORT;
  const all = [...nodes.values()];
  const top = all.length ? Math.min(...all.map((n) => n.y)) : 0;
  const bottom = all.length ? Math.max(...all.map((n) => n.y + NODE_H)) : 0;

  type Route = {
    d: TaskDependency; a: NodeBox; b: NodeBox; straight: boolean;
    channel?: number;
    /** Whether a channel height is clear of every box the arrow passes. */
    clear?: (y: number) => boolean;
  };
  const routes: Route[] = deps.map((d) => {
    const a = nodes.get(d.predecessor_id)!;
    const b = nodes.get(d.successor_id)!;
    return { d, a, b, straight: b.col === a.col + 1 && mid(a.id) === mid(b.id) };
  });

  // 1. Channels for arrows that skip columns.
  const groups = new Map<string, { base: number; kind: 'gap' | 'top' | 'bottom'; members: Route[] }>();
  for (const r of routes) {
    if (r.b.col - r.a.col < 2) continue;
    const between: [number, number][] = [];
    const candidates: number[] = [];
    for (let c = r.a.col + 1; c < r.b.col; c++) {
      const ys = cols[c].map((id) => nodes.get(id)!.y).sort((p, q) => p - q);
      for (const y of ys) between.push([y - CLEAR, y + NODE_H + CLEAR]);
      for (let i = 1; i < ys.length; i++) candidates.push((ys[i - 1] + NODE_H + ys[i]) / 2);
      // The space above and below a column's own boxes is a channel too.
      if (ys.length) candidates.push(ys[0] - ROW_GAP / 2, ys[ys.length - 1] + NODE_H + ROW_GAP / 2);
    }
    const free = (y: number) => !between.some(([lo, hi]) => y > lo && y < hi);
    r.clear = free;
    const want = (mid(r.a.id) + mid(r.b.id)) / 2;
    const inner = candidates.filter((y) => free(y) && y > top && y < bottom);
    let key: string;
    let base: number;
    let kind: 'gap' | 'top' | 'bottom';
    if (inner.length) {
      base = inner.reduce((best, y) => (Math.abs(y - want) < Math.abs(best - want) ? y : best));
      key = `g${Math.round(base)}`;
      kind = 'gap';
    } else {
      // Nothing clear between the rows: go round, over the top or under the bottom.
      kind = Math.abs(top - want) <= Math.abs(bottom - want) ? 'top' : 'bottom';
      base = kind === 'top' ? top - ROW_GAP / 2 : bottom + ROW_GAP / 2;
      key = kind;
    }
    const g = groups.get(key) ?? groups.set(key, { base, kind, members: [] }).get(key)!;
    g.members.push(r);
  }
  // A channel must not sit at the height of any arrow leaving or entering a box, nor
  // reuse another channel's height, or two unrelated lines would share it.
  const portYs = all.flatMap((n) => [outY(n.id), inY(n.id), mid(n.id)]);
  const usedYs: number[] = [];
  const taken = (y: number) => portYs.some((p) => Math.abs(p - y) < 2) || usedYs.some((u) => Math.abs(u - y) < 2);
  for (const g of groups.values()) {
    // Spread arrows that share a channel, ordered so they cross each other as little as they can.
    g.members.sort((p, q) => mid(p.a.id) + mid(p.b.id) - (mid(q.a.id) + mid(q.b.id)) || p.d.predecessor_id - q.d.predecessor_id);
    const n = g.members.length;
    g.members.forEach((r, k) => {
      let y = g.kind === 'gap' ? g.base + (k - (n - 1) / 2) * CHANNEL_TRACK
        : g.kind === 'top' ? g.base - k * CHANNEL_TRACK
        : g.base + k * CHANNEL_TRACK;
      // Nudge off a taken height, alternating up and down, staying clear of the boxes.
      const start = y;
      for (let step = 1; step <= 24 && (taken(y) || !r.clear!(y)); step++) {
        y = start + (step % 2 ? 1 : -1) * Math.ceil(step / 2) * 2;
      }
      if (taken(y) || !r.clear!(y)) {
        // The gap is full: go under everything instead, below every other channel.
        y = Math.max(bottom + ROW_GAP / 2, ...usedYs.map((u) => u + CHANNEL_TRACK));
        for (let guard = 0; guard < 1000 && taken(y); guard++) y += CHANNEL_TRACK;
      }
      usedYs.push(y);
      r.channel = y;
    });
  }

  // 2. Vertical tracks, gutter by gutter.
  const gutters = Math.max(0, cols.length - 1);
  const trackX: Map<string, number>[] = [];
  const width: number[] = [];
  const order: string[][] = [];
  for (let g = 0; g < gutters; g++) {
    const exits = new Map<number, number[]>(); // source -> ys its trunk spans
    const entries = new Map<number, number[]>(); // long-arrow target -> ys
    for (const r of routes) {
      if (r.a.col === g && !r.straight) {
        const ys = exits.get(r.a.id) ?? exits.set(r.a.id, [outY(r.a.id)]).get(r.a.id)!;
        ys.push(r.channel ?? inY(r.b.id));
      }
      if (r.channel != null && r.b.col === g + 1) {
        const ys = entries.get(r.b.id) ?? entries.set(r.b.id, [inY(r.b.id)]).get(r.b.id)!;
        ys.push(r.channel);
      }
    }
    const centre = (ys: number[]) => (Math.min(...ys) + Math.max(...ys)) / 2;
    const placed = [...exits.keys()].sort((p, q) => centre(exits.get(p)!) - centre(exits.get(q)!) || p - q);
    // Fan-out trunks sit nearer their sources, fan-in trunks nearer their targets.
    const entryOrder = [...entries.keys()].sort((p, q) => centre(entries.get(p)!) - centre(entries.get(q)!) || p - q);
    const keys = [...placed.map((s) => `s${s}`), ...entryOrder.map((t) => `t${t}`)];
    order.push(keys);
    width.push(Math.max(COL_GAP, (keys.length + 1) * TRACK));
  }

  const colX: number[] = [];
  for (let c = 0; c < cols.length; c++) colX.push(c === 0 ? 0 : colX[c - 1] + NODE_W + width[c - 1]);
  for (let g = 0; g < gutters; g++) {
    const keys = order[g];
    const left = colX[g] + NODE_W;
    trackX.push(new Map(keys.map((k, i) => [k, left + ((i + 1) * width[g]) / (keys.length + 1)])));
  }

  // 3. Points.
  const edges: EdgePath[] = routes.map((r) => {
    const x1 = colX[r.a.col] + NODE_W;
    const x2 = colX[r.b.col];
    if (r.straight) return { from: r.d.predecessor_id, to: r.d.successor_id, points: [[x1, mid(r.a.id)], [x2, mid(r.b.id)]] };
    const y1 = outY(r.a.id);
    const y2 = inY(r.b.id);
    const out = trackX[r.a.col].get(`s${r.a.id}`)!;
    const into = r.channel != null ? trackX[r.b.col - 1].get(`t${r.b.id}`)! : out;
    const points: [number, number][] = r.channel == null
      ? [[x1, y1], [out, y1], [out, y2], [x2, y2]]
      : [[x1, y1], [out, y1], [out, r.channel], [into, r.channel], [into, y2], [x2, y2]];
    return { from: r.d.predecessor_id, to: r.d.successor_id, points: simplify(points) };
  });
  return { edges, colX };
}

/**
 * An arrow drawn from a route, or from sensible defaults when a box has been
 * dragged and the arrow has no shape of its own. Always orthogonal: out of the
 * source's right side, into the target's left side, going round when the target
 * sits to the left.
 */
export function manualPoints(a: { x: number; y: number }, b: { x: number; y: number }, route: Route | null): [number, number][] {
  const x1 = a.x + NODE_W;
  const y1 = anchorY(a, 'out', route?.from);
  const x2 = b.x;
  const y2 = anchorY(b, 'in', route?.to);
  const backward = x2 < x1 + STUB * 2;
  const out = x1 + (route?.out ?? (backward ? STUB : Math.max(STUB, (x2 - x1) / 2)));
  // A target to the left is reached by going round underneath both boxes.
  const detour = route ? route.y : backward ? Math.max(a.y, b.y) + NODE_H + ROW_GAP / 2 : null;
  if (detour == null) return simplify([[x1, y1], [out, y1], [out, y2], [x2, y2]]);
  const into = x2 - (route?.in ?? STUB);
  return simplify([[x1, y1], [out, y1], [out, detour], [into, detour], [into, y2], [x2, y2]]);
}

/**
 * The route an arrow is drawn with now, whether the router made it or a hand did,
 * so a drag of one of its handles starts from exactly what is on screen.
 */
export function routeOf(points: readonly [number, number][], from: { x: number }, to: { x: number }): Route {
  const x1 = from.x + NODE_W;
  const x2 = to.x;
  if (points.length >= 6) {
    return { out: points[1][0] - x1, y: points[2][1], in: x2 - points[3][0] };
  }
  if (points.length >= 3) return { out: points[1][0] - x1, y: null, in: STUB };
  return { out: Math.max(STUB, (x2 - x1) / 2), y: null, in: STUB };
}

/** Drop repeated points and points in the middle of a straight run. */
function simplify(points: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && last[0] === p[0] && last[1] === p[1]) continue;
    const prev = out[out.length - 2];
    if (last && prev && ((prev[0] === last[0] && last[0] === p[0]) || (prev[1] === last[1] && last[1] === p[1]))) out.pop();
    out.push(p);
  }
  return out;
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
