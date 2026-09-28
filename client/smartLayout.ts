import type { TaskDependency } from '../shared/types.ts';
import { edgeKey, manualPoints, NODE_H, NODE_W, ROW_GAP, STUB, type Anchor, type Route } from './network.ts';

/**
 * Smart Arrange: the best tidy drawing of a plan this module can find, written
 * out as an ordinary hand arrangement (box positions plus arrow routes), so it
 * can be tweaked, saved, shared and undone like any other.
 *
 * It is a layered (Sugiyama) layout on a strict grid:
 *
 * 1. Columns by longest chain, then a task with more successors than
 *    predecessors is pulled right, next to its earliest successor, so start
 *    tasks do not trail long arrows across the page.
 * 2. An arrow that skips columns rides a *lane* of its own: one row, reserved in
 *    every column it crosses, shared by all of one source's long arrows. It is a
 *    straight line through empty slots, so it can never touch a box.
 * 3. Rows within columns are ordered to cross as little as possible: barycentre
 *    sweeps from several starting orders, adjacent swaps, the best kept.
 * 4. Every box and lane then gets a whole row, chosen to make arrows as level as
 *    possible (the critical path weighs most, so it runs as one straight line).
 *    Boxes line up across columns because rows are shared.
 * 5. Arrows attach at one of three anchors per side: the middle for a level
 *    arrow, the top quarter towards a row above, the bottom quarter towards one
 *    below. Each gutter's vertical runs get their own tracks, ordered to cross
 *    as little as possible, and the gutter is widened to fit them.
 *
 * Only arrows with the same source or the same target ever share a line. Every
 * loop is bounded by the node count or a fixed pass count (see CLAUDE.md).
 */

export type ArrangeTask = { id: number; start: string; critical: boolean };
export type Arrangement = {
  positions: Map<number, { x: number; y: number }>;
  routes: Map<string, Route>;
};

const STRIDE = NODE_H + ROW_GAP;
/** Space between vertical tracks in a gutter, and the narrowest gutter. */
const TRACK = 12;
const MIN_GUTTER = 64;
const GRID = 8;
const SWEEPS = 24;
/** How much more a critical link wants to be level than any other; beats a wide fan-in. */
const CRITICAL = 8;
/**
 * A lane is straight whatever row it gets, so its links weigh less, and never
 * count as the critical chain: a redundant critical link skipping a column would
 * otherwise tie the chain into a loop that cannot be levelled.
 */
const LANE_CRITICAL = 3;
/** A lane is nudged this far below its row's middle when another lane ends where it starts. */
const LANE_NUDGE = 8;

type Item =
  | { kind: 'box'; id: number; c1: number; c2: number; lonely: boolean }
  | { kind: 'lane'; src: number; c1: number; c2: number; targets: number[]; lonely: false };
/**
 * Whether a task slides right towards its successors: when it has more of them
 * than predecessors, also when it has as many, or never. All three are tried.
 */
type Promote = 'more' | 'ties' | 'none';
/** A link between an item in column g and one in column g + 1. */
type Pair = { u: number; v: number; w: number };

export function smartArrange(
  tasks: readonly ArrangeTask[],
  deps: readonly TaskDependency[],
  order: readonly number[],
): Arrangement {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ids = order.filter((id) => byId.has(id));
  const live = deps.filter((d) => byId.has(d.predecessor_id) && byId.has(d.successor_id) && d.predecessor_id !== d.successor_id);
  if (!ids.length) return { positions: new Map(), routes: new Map() };

  const preds = new Map<number, number[]>();
  const succs = new Map<number, number[]>();
  for (const d of live) {
    (preds.get(d.successor_id) ?? preds.set(d.successor_id, []).get(d.successor_id)!).push(d.predecessor_id);
    (succs.get(d.predecessor_id) ?? succs.set(d.predecessor_id, []).get(d.predecessor_id)!).push(d.successor_id);
  }

  let best: { score: number; result: Arrangement } | null = null;
  for (const promote of ['more', 'ties', 'none'] as const) {
    for (const start of ['walk', 'date'] as const) {
      const cand = arrange(ids, byId, live, preds, succs, promote, start);
      if (!best || cand.score < best.score) best = cand;
    }
  }
  return best!.result;
}

function arrange(
  ids: readonly number[],
  byId: ReadonlyMap<number, ArrangeTask>,
  live: readonly TaskDependency[],
  preds: ReadonlyMap<number, number[]>,
  succs: ReadonlyMap<number, number[]>,
  promote: Promote,
  start: 'walk' | 'date',
): { score: number; result: Arrangement } {
  const colOf = layers(ids, preds, succs, promote);
  const col = (id: number) => colOf.get(id)!;
  const columns = Math.max(...colOf.values()) + 1;
  const critical = (d: TaskDependency) => byId.get(d.predecessor_id)!.critical && byId.get(d.successor_id)!.critical;

  // Items: every box, and one lane per source with arrows that skip columns.
  const items: Item[] = [];
  const boxItem = new Map<number, number>();
  for (const id of ids) {
    boxItem.set(id, items.length);
    const lonely = !(preds.get(id)?.length) && !(succs.get(id)?.length);
    items.push({ kind: 'box', id, c1: col(id), c2: col(id), lonely });
  }
  const laneOf = new Map<number, number>();
  for (const id of ids) {
    const far = (succs.get(id) ?? []).filter((s) => col(s) >= col(id) + 2);
    if (!far.length) continue;
    laneOf.set(id, items.length);
    items.push({ kind: 'lane', src: id, c1: col(id) + 1, c2: Math.max(...far.map(col)) - 1, targets: far, lonely: false });
  }

  const pairs: Pair[][] = Array.from({ length: Math.max(0, columns - 1) }, () => []);
  for (const d of live) {
    const a = col(d.predecessor_id);
    if (col(d.successor_id) === a + 1) {
      pairs[a].push({ u: boxItem.get(d.predecessor_id)!, v: boxItem.get(d.successor_id)!, w: critical(d) ? CRITICAL : 1 });
    }
  }
  for (const [src, li] of laneOf) {
    const lane = items[li] as Extract<Item, { kind: 'lane' }>;
    const heavy = live.some((d) => d.predecessor_id === src && lane.targets.includes(d.successor_id) && critical(d));
    pairs[lane.c1 - 1].push({ u: boxItem.get(src)!, v: li, w: heavy ? LANE_CRITICAL : 2 });
    for (let c = lane.c1; c < lane.c2; c++) pairs[c].push({ u: li, v: li, w: 2 });
    for (const t of lane.targets) {
      const d = live.find((x) => x.predecessor_id === src && x.successor_id === t)!;
      pairs[col(t) - 1].push({ u: li, v: boxItem.get(t)!, w: critical(d) ? LANE_CRITICAL : 2 });
    }
  }

  const ord = orderColumns(items, pairs, columns, ids, byId, succs, boxItem, laneOf, start);
  const row = assignRows(items, pairs, ord);
  const result = geometry(items, row, columns, live, colOf, boxItem, laneOf);
  return { score: score(result, live), result };
}

/** Longest-chain columns, optionally pulling tasks right; empty columns closed. */
function layers(
  ids: readonly number[],
  preds: ReadonlyMap<number, number[]>,
  succs: ReadonlyMap<number, number[]>,
  promote: Promote,
): Map<number, number> {
  const col = new Map<number, number>();
  for (const id of ids) {
    let c = 0;
    for (const p of preds.get(id) ?? []) c = Math.max(c, (col.get(p) ?? 0) + 1);
    col.set(id, c);
  }
  if (promote !== 'none') {
    for (let pass = 0; pass < 4; pass++) {
      let changed = false;
      for (let i = ids.length - 1; i >= 0; i--) {
        const id = ids[i];
        const s = succs.get(id) ?? [];
        const ins = preds.get(id)?.length ?? 0;
        if (!s.length || s.length < ins || (s.length === ins && promote === 'more')) continue;
        const hi = Math.min(...s.map((x) => col.get(x)!)) - 1;
        if (hi > col.get(id)!) { col.set(id, hi); changed = true; }
      }
      if (!changed) break;
    }
  }
  const used = [...new Set(col.values())].sort((a, b) => a - b);
  const remap = new Map(used.map((c, i) => [c, i]));
  for (const [id, c] of col) col.set(id, remap.get(c)!);
  return col;
}

// ---------------------------------------------------------------- order within columns

function orderColumns(
  items: readonly Item[],
  pairs: readonly Pair[][],
  columns: number,
  ids: readonly number[],
  byId: ReadonlyMap<number, ArrangeTask>,
  succs: ReadonlyMap<number, number[]>,
  boxItem: ReadonlyMap<number, number>,
  laneOf: ReadonlyMap<number, number>,
  start: 'walk' | 'date',
): number[][] {
  // Starting order: a depth-first walk of the plan, or plain schedule order.
  const key = new Map<number, number>();
  if (start === 'walk') {
    const seen = new Set<number>();
    const rankInOrder = new Map(ids.map((id, i) => [id, i]));
    let n = 0;
    const stack: number[] = [];
    for (const root of ids) {
      if (seen.has(root)) continue;
      stack.push(root);
      for (let guard = 0; stack.length && guard < ids.length * 4 + 4; guard++) {
        const id = stack.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        key.set(id, n++);
        const next = [...(succs.get(id) ?? [])].sort((a, b) => rankInOrder.get(b)! - rankInOrder.get(a)!);
        for (const s of next) if (!seen.has(s)) stack.push(s);
      }
    }
  } else {
    [...ids].sort((a, b) => byId.get(a)!.start.localeCompare(byId.get(b)!.start) || a - b).forEach((id, i) => key.set(id, i));
  }
  const itemKey = (i: number) => {
    const it = items[i];
    return it.kind === 'box' ? key.get(it.id) ?? 0 : (key.get(it.src) ?? 0) + 0.5;
  };

  const ord: number[][] = Array.from({ length: columns }, () => []);
  items.forEach((it, i) => { for (let c = it.c1; c <= it.c2; c++) ord[c].push(i); });
  // Tasks with no links at all sit at the foot of their column.
  const lonelyLast = (a: number, b: number) => Number(items[a].lonely) - Number(items[b].lonely);
  for (const c of ord) c.sort((a, b) => lonelyLast(a, b) || itemKey(a) - itemKey(b) || a - b);

  const leftN: Map<number, Pair[]>[] = Array.from({ length: columns }, () => new Map());
  const rightN: Map<number, Pair[]>[] = Array.from({ length: columns }, () => new Map());
  pairs.forEach((ps, g) => ps.forEach((p) => {
    (leftN[g + 1].get(p.v) ?? leftN[g + 1].set(p.v, []).get(p.v)!).push(p);
    (rightN[g].get(p.u) ?? rightN[g].set(p.u, []).get(p.u)!).push(p);
  }));

  // Each item's place in each column, kept current as columns are reordered.
  const rank = Array.from({ length: columns }, () => new Int32Array(items.length));
  const reindex = (c: number) => ord[c].forEach((it, i) => { rank[c][it] = i; });
  const reindexAll = () => { for (let c = 0; c < columns; c++) reindex(c); };
  reindexAll();
  const crossGutter = (g: number) => {
    if (g < 0 || g >= pairs.length) return 0;
    const ra = rank[g];
    const rb = rank[g + 1];
    const ps = pairs[g];
    let x = 0;
    for (let i = 0; i < ps.length; i++) {
      for (let j = i + 1; j < ps.length; j++) {
        if ((ra[ps[i].u] - ra[ps[j].u]) * (rb[ps[i].v] - rb[ps[j].v]) < 0) x += ps[i].w * ps[j].w;
      }
    }
    return x;
  };
  /**
   * What swapping a (just above) with b in column c does to crossings. Only the
   * links of a against the links of b can change, so only those are counted.
   */
  const swapGain = (c: number, a: number, b: number) => {
    let before = 0;
    let after = 0;
    for (const [nb, other] of [[rightN[c], rank[c + 1]], [leftN[c], rank[c - 1]]] as const) {
      if (!other) continue;
      const pa = nb.get(a) ?? [];
      const pb = nb.get(b) ?? [];
      const far = (p: Pair, self: number) => other[p.u === self ? p.v : p.u];
      for (const p of pa) {
        for (const q of pb) {
          const d = far(p, a) - far(q, b);
          if (d > 0) before += p.w * q.w;
          else if (d < 0) after += p.w * q.w;
        }
      }
    }
    return before - after;
  };
  const crossings = () => pairs.reduce((s, _, g) => s + crossGutter(g), 0);

  // A lane is one row across all its columns, so lanes must keep one order
  // relative to each other everywhere; boxes only live in one column.
  const reconcile = () => {
    const lanes = [...laneOf.values()];
    if (lanes.length < 2) return;
    const gkey = new Map(lanes.map((li) => {
      const it = items[li];
      let s = 0;
      for (let c = it.c1; c <= it.c2; c++) s += ord[c].indexOf(li) / ord[c].length;
      return [li, s / (it.c2 - it.c1 + 1)];
    }));
    for (const c of ord) {
      const slots = c.map((it, i) => (items[it].kind === 'lane' ? i : -1)).filter((i) => i >= 0);
      const sorted = slots.map((i) => c[i]).sort((a, b) => gkey.get(a)! - gkey.get(b)! || a - b);
      slots.forEach((i, k) => { c[i] = sorted[k]; });
    }
    reindexAll();
  };

  const transpose = () => {
    for (let pass = 0; pass < 8; pass++) {
      let improved = false;
      for (let c = 0; c < columns; c++) {
        for (let i = 0; i + 1 < ord[c].length; i++) {
          const a = ord[c][i];
          const b = ord[c][i + 1];
          if (items[a].kind === 'lane' && items[b].kind === 'lane') continue;
          if (items[a].lonely !== items[b].lonely) continue;
          if (swapGain(c, a, b) <= 0) continue;
          ord[c][i] = b; ord[c][i + 1] = a;
          rank[c][a] = i + 1; rank[c][b] = i;
          improved = true;
        }
      }
      if (!improved) break;
    }
  };

  reconcile();
  transpose();
  let bestX = crossings();
  let bestOrd = ord.map((c) => [...c]);
  for (let sweep = 0; sweep < SWEEPS && bestX > 0; sweep++) {
    const down = sweep % 2 === 0;
    for (let k = 1; k < columns; k++) {
      const c = down ? k : columns - 1 - k;
      const ref = rank[down ? c - 1 : c + 1];
      const here = rank[c];
      const nb = down ? leftN[c] : rightN[c];
      const score = new Map(ord[c].map((it) => {
        const ns = nb.get(it);
        if (!ns?.length) return [it, here[it]];
        let sw = 0;
        let s = 0;
        for (const p of ns) { sw += p.w; s += p.w * ref[down ? p.u : p.v]; }
        return [it, s / sw];
      }));
      ord[c].sort((a, b) => lonelyLast(a, b) || score.get(a)! - score.get(b)! || here[a] - here[b]);
      reindex(c);
    }
    reconcile();
    transpose();
    const x = crossings();
    if (x < bestX) { bestX = x; bestOrd = ord.map((c) => [...c]); }
  }
  return bestOrd;
}

// ---------------------------------------------------------------- rows

/**
 * Whole rows for every item, keeping each column's order, so arrows are as level
 * as they can be. Weighted L1 over links, improved by single moves and by
 * shifting an item with everything it holds up (or down) together.
 */
function assignRows(items: readonly Item[], pairs: readonly Pair[][], ord: readonly number[][]): number[] {
  const n = items.length;
  const above: Set<number>[] = Array.from({ length: n }, () => new Set());
  const below: Set<number>[] = Array.from({ length: n }, () => new Set());
  for (const c of ord) {
    for (let i = 0; i + 1 < c.length; i++) { below[c[i]].add(c[i + 1]); above[c[i + 1]].add(c[i]); }
  }

  // Start packed to the top: longest path through the "is above" relation.
  const row = new Array<number>(n).fill(0);
  const indeg = above.map((s) => s.size);
  const queue = indeg.map((d, i) => (d === 0 ? i : -1)).filter((i) => i >= 0);
  for (let q = 0; q < queue.length && q < n; q++) {
    const a = queue[q];
    for (const b of below[a]) {
      row[b] = Math.max(row[b], row[a] + 1);
      if (--indeg[b] === 0) queue.push(b);
    }
  }

  const links = pairs.flat().filter((p) => p.u !== p.v);
  const nbrs: { n: number; w: number }[][] = Array.from({ length: n }, () => []);
  for (const p of links) { nbrs[p.u].push({ n: p.v, w: p.w }); nbrs[p.v].push({ n: p.u, w: p.w }); }
  const itemCost = (i: number, r: number) => nbrs[i].reduce((s, x) => s + x.w * Math.abs(r - row[x.n]), 0);

  const closure = (i: number, next: Set<number>[]) => {
    const out = new Set([i]);
    const stack = [i];
    for (let guard = 0; stack.length && guard < n * n + 1; guard++) {
      for (const j of next[stack.pop()!]) if (!out.has(j)) { out.add(j); stack.push(j); }
    }
    return out;
  };
  const shiftGain = (set: Set<number>, by: number) => {
    let delta = 0;
    for (const p of links) {
      const inU = set.has(p.u);
      if (inU === set.has(p.v)) continue;
      const before = Math.abs(row[p.u] - row[p.v]);
      const after = Math.abs(row[p.u] + (inU ? by : 0) - row[p.v] - (inU ? 0 : by));
      delta += p.w * (after - before);
    }
    return delta;
  };

  const heavy = links.filter((p) => p.w >= CRITICAL);
  /** The items joined to `from` by critical links, not counting the link `cut`. */
  const heavySide = (from: number, cut: Pair) => {
    const out = new Set([from]);
    const stack = [from];
    for (let guard = 0; stack.length && guard < n * n + 1; guard++) {
      const i = stack.pop()!;
      for (const p of heavy) {
        if (p === cut) continue;
        const j = p.u === i ? p.v : p.v === i ? p.u : -1;
        if (j >= 0 && !out.has(j)) { out.add(j); stack.push(j); }
      }
    }
    return out;
  };

  for (let pass = 0; pass < 60; pass++) {
    let improved = false;
    const seq = [...row.keys()].sort((a, b) => (pass % 2 ? row[b] - row[a] : row[a] - row[b]) || a - b);
    for (const i of seq) {
      if (!nbrs[i].length) continue;
      let lo = -Infinity;
      let hi = Infinity;
      for (const a of above[i]) lo = Math.max(lo, row[a] + 1);
      for (const b of below[i]) hi = Math.min(hi, row[b] - 1);
      const cands = [...nbrs[i].map((x) => row[x.n]), lo, hi].filter(Number.isFinite).map((r) => Math.min(hi, Math.max(lo, r)));
      const now = itemCost(i, row[i]);
      let pick = row[i];
      let pickCost = now;
      for (const r of cands) {
        const c = itemCost(i, r);
        if (c < pickCost || (c === pickCost && Math.abs(r - row[i]) < Math.abs(pick - row[i]))) { pick = r; pickCost = c; }
      }
      if (pickCost < now) { row[i] = pick; improved = true; }
    }
    for (const i of seq) {
      if (!nbrs[i].length) continue;
      const down = closure(i, below);
      if (shiftGain(down, 1) < 0) { for (const j of down) row[j]++; improved = true; continue; }
      const up = closure(i, above);
      if (shiftGain(up, -1) < 0) { for (const j of up) row[j]--; improved = true; }
    }
    // Levelling one critical link means moving everything on its far side with it.
    for (const p of heavy) {
      if (row[p.u] === row[p.v]) continue;
      for (const [near, far] of [[p.u, p.v], [p.v, p.u]]) {
        const side = heavySide(far, p);
        if (side.has(near)) continue;
        const by = Math.sign(row[near] - row[far]);
        const set = new Set<number>();
        for (const j of side) for (const k of closure(j, by > 0 ? below : above)) set.add(k);
        if (shiftGain(set, by) < 0) { for (const j of set) row[j] += by; improved = true; break; }
      }
    }
    if (!improved) break;
  }

  // From zero, with rows nobody uses taken out.
  const used = [...new Set(row)].sort((a, b) => a - b);
  const remap = new Map(used.map((r, i) => [r, i]));
  return row.map((r) => remap.get(r)!);
}

// ---------------------------------------------------------------- geometry

type Track = { key: string; left: number[]; right: number[]; edges: string[] };
type Pass = { y: number; edges: string[] };

function geometry(
  items: readonly Item[],
  row: readonly number[],
  columns: number,
  live: readonly TaskDependency[],
  colOf: ReadonlyMap<number, number>,
  boxItem: ReadonlyMap<number, number>,
  laneOf: ReadonlyMap<number, number>,
): Arrangement {
  const col = (id: number) => colOf.get(id)!;
  const rowOf = (id: number) => row[boxItem.get(id)!];
  const top = (r: number) => r * STRIDE;
  const outY = (id: number, a: Anchor) => top(rowOf(id)) + ({ top: 14, mid: NODE_H / 2, bottom: NODE_H - 20 })[a];
  const inY = (id: number, a: Anchor) => top(rowOf(id)) + ({ top: 20, mid: NODE_H / 2, bottom: NODE_H - 14 })[a];
  const toward = (from: number, to: number): Anchor => (to === from ? 'mid' : to < from ? 'top' : 'bottom');
  /** The anchor on a box's side facing a lane at height y. */
  const facing = (id: number, y: number): Anchor => {
    const mid = top(rowOf(id)) + NODE_H / 2;
    return y === mid ? 'mid' : y < mid ? 'top' : 'bottom';
  };

  // Lane heights: the row's middle, nudged when another lane ends where this one starts.
  const laneY = new Map<number, number>();
  const lanes = [...laneOf.values()].sort((a, b) => items[a].c1 - items[b].c1 || a - b);
  for (const li of lanes) {
    const it = items[li];
    const before = lanes.find((o) => o !== li && laneY.has(o) && row[o] === row[li] && items[o].c2 === it.c1 - 1);
    const nudge = before != null && laneY.get(before) === top(row[li]) + NODE_H / 2 ? LANE_NUDGE : 0;
    laneY.set(li, top(row[li]) + NODE_H / 2 + nudge);
  }

  type Plan = { d: TaskDependency; key: string; from: Anchor; to: Anchor; lane?: number };
  const plans: Plan[] = live.map((d) => {
    const s = d.predecessor_id;
    const t = d.successor_id;
    const key = edgeKey(s, t);
    if (col(t) === col(s) + 1) return { d, key, from: toward(rowOf(s), rowOf(t)), to: toward(rowOf(t), rowOf(s)) };
    const li = laneOf.get(s)!;
    const y = laneY.get(li)!;
    return { d, key, from: facing(s, y), to: facing(t, y), lane: li };
  });

  // How many arrows reach each (target, anchor). A shared anchor may not be
  // bundled at the source; arrows from the next column into it merge on a trunk
  // of the target's instead, where that reads unambiguously.
  const feeders = new Map<string, number>();
  const nearFeeders = new Map<string, number>();
  for (const p of plans) {
    const k = `${p.d.successor_id}:${p.to}`;
    feeders.set(k, (feeders.get(k) ?? 0) + 1);
    if (p.lane == null && p.to !== 'mid') nearFeeders.set(k, (nearFeeders.get(k) ?? 0) + 1);
  }

  /** One arrow's use of a gutter track; `alt` is its own track if the merge is refused. */
  type Hook = { key: string; alt?: string; left: number | null; right: number | null; edge: string };
  const hooks: Hook[][] = Array.from({ length: Math.max(0, columns - 1) }, () => []);
  const passes: Pass[][] = Array.from({ length: Math.max(0, columns - 1) }, () => []);
  const hookOf = new Map<string, { out?: Hook; in?: Hook }>();
  const laneEdges = new Map<number, string[]>();
  for (const p of plans) {
    const s = p.d.predecessor_id;
    const t = p.d.successor_id;
    const yi = inY(t, p.to);
    const k = `${t}:${p.to}`;
    if (p.lane == null) {
      if (p.from === 'mid') { passes[col(s)].push({ y: yi, edges: [p.key] }); continue; }
      const h: Hook = (nearFeeders.get(k) ?? 0) > 1
        ? { key: `t${t}${p.to}`, alt: `e${p.key}`, left: outY(s, p.from), right: yi, edge: p.key }
        : { key: (feeders.get(k) ?? 0) > 1 ? `e${p.key}` : `s${s}${p.from}`, left: outY(s, p.from), right: yi, edge: p.key };
      hooks[col(s)].push(h);
      hookOf.set(p.key, { out: h });
      continue;
    }
    const y = laneY.get(p.lane)!;
    (laneEdges.get(p.lane) ?? laneEdges.set(p.lane, []).get(p.lane)!).push(p.key);
    const used: { out?: Hook; in?: Hook } = {};
    if (p.from !== 'mid') hooks[col(s)].push(used.out = { key: `s${s}${p.from}`, left: outY(s, p.from), right: y, edge: p.key });
    if (p.to === 'mid') passes[col(t) - 1].push({ y, edges: [p.key] });
    else hooks[col(t) - 1].push(used.in = { key: `c${p.key}`, left: y, right: yi, edge: p.key });
    hookOf.set(p.key, used);
  }
  for (const [li, edges] of laneEdges) {
    const it = items[li];
    const y = laneY.get(li)!;
    // Straight out of its source when the lane is on the source's row.
    const from = plans.find((p) => p.lane === li)!.from;
    if (from === 'mid') passes[it.c1 - 1].push({ y, edges });
    for (let g = it.c1; g < it.c2; g++) passes[g].push({ y, edges });
  }

  const ends = new Map(plans.map((p) => [p.key, p.d]));
  const build = (hs: readonly Hook[], unmerged: boolean) => {
    const m = new Map<string, Track>();
    for (const h of hs) {
      const key = unmerged && h.alt ? h.alt : h.key;
      const tr = m.get(key) ?? m.set(key, { key, left: [], right: [], edges: [] }).get(key)!;
      if (h.left != null && !tr.left.includes(h.left)) tr.left.push(h.left);
      if (h.right != null && !tr.right.includes(h.right)) tr.right.push(h.right);
      if (!tr.edges.includes(h.edge)) tr.edges.push(h.edge);
    }
    return [...m.values()];
  };

  // Order each gutter's tracks to cross as little as possible, then size the gutter.
  const unmerged = hooks.map(() => false);
  const orders: Track[][] = hooks.map((hs, g) => {
    const merged = arrangeTracks(build(hs, false), passes[g], ends);
    if (!merged.ambiguous || !hs.some((h) => h.alt)) return merged.order;
    unmerged[g] = true;
    return arrangeTracks(build(hs, true), passes[g], ends).order;
  });
  const widths = orders.map((o) => Math.max(MIN_GUTTER, Math.ceil(((o.length + 1) * TRACK) / GRID) * GRID));
  const colX: number[] = [];
  for (let c = 0; c < columns; c++) colX.push(c === 0 ? 0 : colX[c - 1] + NODE_W + widths[c - 1]);
  const trackX = (g: number, h: Hook) => {
    const key = unmerged[g] && h.alt ? h.alt : h.key;
    const i = orders[g].findIndex((t) => t.key === key);
    return colX[g] + NODE_W + Math.round(((i + 1) * widths[g]) / (orders[g].length + 1));
  };

  const positions = new Map<number, { x: number; y: number }>();
  for (const it of items) if (it.kind === 'box') positions.set(it.id, { x: colX[it.c1], y: top(row[boxItem.get(it.id)!]) });

  const routes = new Map<string, Route>();
  for (const p of plans) {
    const s = p.d.predecessor_id;
    const t = p.d.successor_id;
    const x1 = colX[col(s)] + NODE_W;
    const x2 = colX[col(t)];
    const h = hookOf.get(p.key);
    const out = h?.out ? trackX(col(s), h.out) - x1 : STUB;
    if (p.lane == null) {
      routes.set(p.key, { out, y: null, in: STUB, from: p.from, to: p.to });
      continue;
    }
    const inn = h?.in ? x2 - trackX(col(t) - 1, h.in) : STUB;
    routes.set(p.key, { out, y: laneY.get(p.lane)!, in: inn, from: p.from, to: p.to });
  }
  return { positions, routes };
}

/**
 * The order of a gutter's vertical tracks that crosses least. Horizontal runs
 * enter a track from the gutter's left edge or leave it to the right edge; lines
 * passing straight through cross whatever spans their height.
 *
 * A line running through a point where a track turns reads as a junction. That
 * is only honest when every arrow involved shares one source or one target;
 * otherwise the order is `ambiguous`, and the caller splits merged arrows apart.
 */
function arrangeTracks(
  list: Track[],
  passes: readonly Pass[],
  ends: ReadonlyMap<string, TaskDependency>,
): { order: Track[]; ambiguous: boolean } {
  const touches = (a: string[], b: string[]) => a.some((x) => b.some((y) => {
    const p = ends.get(x)!;
    const q = ends.get(y)!;
    return p.predecessor_id === q.predecessor_id || p.successor_id === q.successor_id;
  }));
  const oneFamily = (a: string[], b: string[]) => {
    const all = [...a, ...b].map((k) => ends.get(k)!);
    return all.every((d) => d.predecessor_id === all[0].predecessor_id) || all.every((d) => d.successor_id === all[0].successor_id);
  };
  const measure = (order: readonly Track[]) => {
    const n = order.length;
    const H: { y: number; x0: number; x1: number; e: string[] }[] = passes.map((p) => ({ y: p.y, x0: 0, x1: n + 1, e: p.edges }));
    const V: { x: number; y0: number; y1: number; turns: number[]; e: string[] }[] = [];
    order.forEach((t, i) => {
      const x = i + 1;
      for (const y of t.left) H.push({ y, x0: 0, x1: x, e: t.edges });
      for (const y of t.right) H.push({ y, x0: x, x1: n + 1, e: t.edges });
      const turns = [...t.left, ...t.right];
      V.push({ x, y0: Math.min(...turns), y1: Math.max(...turns), turns, e: t.edges });
    });
    let crossings = 0;
    let junctions = 0;
    for (const h of H) {
      for (const v of V) {
        if (!(h.x0 < v.x && v.x < h.x1)) continue;
        if (v.turns.includes(h.y)) { if (!oneFamily(h.e, v.e)) junctions++; }
        else if (v.y0 < h.y && h.y < v.y1 && !touches(h.e, v.e)) crossings++;
      }
    }
    // Ties go to the shorter horizontal runs.
    let len = 0;
    order.forEach((t, i) => { len += t.left.length * (i + 1) + t.right.length * (n - i); });
    return { cost: junctions * 50_000 + crossings * 1000 + len, junctions };
  };
  const mean = (t: Track) => [...t.left, ...t.right].reduce((s, y) => s + y, 0) / (t.left.length + t.right.length);
  let order = [...list].sort((a, b) => mean(a) - mean(b) || a.key.localeCompare(b.key));
  let now = measure(order);
  for (let pass = 0; pass < 20 && order.length > 1; pass++) {
    let improved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = 0; j < order.length; j++) {
        if (i === j) continue;
        const next = [...order];
        const [t] = next.splice(i, 1);
        next.splice(j, 0, t);
        const m = measure(next);
        if (m.cost < now.cost) { order = next; now = m; improved = true; }
      }
    }
    if (!improved) break;
  }
  return { order, ambiguous: now.junctions > 0 };
}

/** Lower is better: crossings first, then turns, then size. */
function score(a: Arrangement, live: readonly TaskDependency[]): number {
  const segs: { from: number; to: number; a: [number, number]; b: [number, number] }[] = [];
  let bends = 0;
  let length = 0;
  for (const d of live) {
    const pts = manualPoints(a.positions.get(d.predecessor_id)!, a.positions.get(d.successor_id)!, a.routes.get(edgeKey(d.predecessor_id, d.successor_id)) ?? null);
    bends += pts.length - 2;
    for (let i = 1; i < pts.length; i++) {
      segs.push({ from: d.predecessor_id, to: d.successor_id, a: pts[i - 1], b: pts[i] });
      length += Math.abs(pts[i][0] - pts[i - 1][0]) + Math.abs(pts[i][1] - pts[i - 1][1]);
    }
  }
  let crossings = 0;
  for (let i = 0; i < segs.length; i++) {
    for (let j = i + 1; j < segs.length; j++) {
      const p = segs[i];
      const q = segs[j];
      if (p.from === q.from || p.to === q.to) continue;
      const ph = p.a[1] === p.b[1];
      const qh = q.a[1] === q.b[1];
      if (ph === qh) continue;
      const [h, v] = ph ? [p, q] : [q, p];
      const hx0 = Math.min(h.a[0], h.b[0]);
      const hx1 = Math.max(h.a[0], h.b[0]);
      const vy0 = Math.min(v.a[1], v.b[1]);
      const vy1 = Math.max(v.a[1], v.b[1]);
      if (hx0 < v.a[0] && v.a[0] < hx1 && vy0 < h.a[1] && h.a[1] < vy1) crossings++;
    }
  }
  let height = 0;
  let width = 0;
  for (const p of a.positions.values()) { height = Math.max(height, p.y + NODE_H); width = Math.max(width, p.x + NODE_W); }
  return crossings * 400 + bends * 30 + length / 10 + height / 4 + width / 20;
}
