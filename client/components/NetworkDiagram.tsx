import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { Environment, Task, TaskDependency, TaskSchedule } from '../../shared/types.ts';
import { formatDate } from '../layout.ts';
import {
  edgeKey, layoutNetwork, NODE_H, NODE_W, roundedPath, routeOf, STUB, type Anchor, type LayoutLane, type Route,
} from '../network.ts';
import { smartArrange, type Arrangement } from '../smartLayout.ts';
import { ENV_COLOR } from './Board.tsx';

/** Zoom runs in fixed steps, like the board's grains, never continuously. */
const ZOOMS = [0.5, 0.65, 0.8, 1, 1.2];
/** Dragged boxes land on this grid, so hand arrangements line up without effort. */
const GRID = 8;
/** Movement, in screen pixels, before a press on a box becomes a drag rather than a click. */
const SLOP = 4;
/** How far Alt+arrow moves a focused box. */
const KEY_STEP = GRID * 2;

const snap = (v: number, to: number) => Math.round(v / to) * to;

type Drag =
  | { kind: 'node'; id: number; startX: number; startY: number; orig: { x: number; y: number }; pos: { x: number; y: number }; moved: boolean }
  | { kind: 'handle'; key: string; from: number; to: number; which: 'out' | 'y' | 'in'; startX: number; startY: number; orig: Route; baseY: number; route: Route }
  /** A new link, drawn from a box's port: `at` is the pointer in layout coordinates, `over` the box under it. */
  | { kind: 'link'; from: number; at: { x: number; y: number }; over: number | null };

/**
 * Activity-on-node network. Each node is the classic scheduling box: early start,
 * duration and early finish on top; late start, float and late finish beneath.
 * The critical path is the one bold thing here: heavy boxes, and arrows in the
 * critical red (by request, as on the Gantt chart). Lines only, never a fill, so
 * they do not read as a double-booking.
 *
 * The automatic layout is a starting point. Boxes can be dragged anywhere, and an
 * arrow, once clicked, shows handles that move its runs. Both are saved with the
 * plan and shared; neither touches the schedule.
 *
 * The dot on a box's right edge draws a new link: drop it on another box and
 * that task comes after this one (finish-to-start), saved like a link drawn on
 * the Gantt chart, so it does move the schedule.
 */
export function NetworkDiagram({
  tasks, deps, schedule, order, environments, showEnvironments, criticalOnly, onOpenTask,
  onMoveTask, onRouteEdge, onLink, onResetLayout, onArrange, onUndoArrange,
}: {
  tasks: readonly Task[];
  deps: readonly TaskDependency[];
  schedule: ReadonlyMap<number, TaskSchedule>;
  /** Dependency order, predecessors first. */
  order: readonly number[];
  environments: readonly Environment[];
  showEnvironments: boolean;
  criticalOnly: boolean;
  onOpenTask: (id: number) => void;
  /** Save where a box was dropped; null puts it back in its automatic place. */
  onMoveTask: (id: number, pos: { x: number; y: number } | null) => void;
  /** Save an arrow's shape; null makes it automatic again. */
  onRouteEdge: (from: number, to: number, route: Route | null) => void;
  /** Make `successorId` come after `predecessorId`. */
  onLink: (predecessorId: number, successorId: number) => void;
  onResetLayout: () => void;
  /** Save a whole arrangement from Smart Arrange. */
  onArrange: (arrangement: Arrangement) => void;
  /** Put back what the last Smart Arrange replaced; absent when there is nothing to undo. */
  onUndoArrange?: () => void;
}) {
  const [zoom, setZoom] = useState(3);
  /** The task under the pointer or the keyboard: its own arrows come forward, the rest recede. */
  const [focused, setFocused] = useState<number | null>(null);
  /** The arrow showing its handles. */
  const [selected, setSelected] = useState<string | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  dragRef.current = drag;
  /** A drag ends in a click event; this stops that click from opening the task. */
  const suppressClick = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<number, HTMLButtonElement>());

  // Hand arrangement belongs to the plain view; environment lanes lay themselves out.
  const arrangeable = !showEnvironments;
  const scale = ZOOMS[zoom];

  const pad = 24;
  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const lanes = useMemo<LayoutLane[] | undefined>(() => {
    if (!showEnvironments) return undefined;
    const used = new Set(tasks.map((t) => t.environment_id));
    // Board order, only the environments this plan touches, and the unbooked work last.
    const list: LayoutLane[] = environments.filter((e) => used.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
    if (used.has(null)) list.push({ id: null, name: 'No environment' });
    return list;
  }, [showEnvironments, tasks, environments]);

  const saved = useMemo(() => ({
    positions: new Map(tasks.filter((t) => t.net_x != null && t.net_y != null).map((t) => [t.id, { x: t.net_x!, y: t.net_y! }])),
    routes: new Map<string, Route>(deps.filter((d) => d.route_out != null).map((d) => [
      edgeKey(d.predecessor_id, d.successor_id),
      {
        out: d.route_out!, y: d.route_y ?? null, in: d.route_in ?? STUB,
        from: (d.route_from as Anchor | null) ?? undefined, to: (d.route_to as Anchor | null) ?? undefined,
      },
    ])),
  }), [tasks, deps]);

  const overrides = useMemo(() => {
    if (!arrangeable) return {};
    const positions = new Map(saved.positions);
    const routes = new Map(saved.routes);
    // What is under the pointer right now wins over what was saved.
    if (drag?.kind === 'node' && drag.moved) positions.set(drag.id, drag.pos);
    if (drag?.kind === 'handle') routes.set(drag.key, drag.route);
    return { positions, routes };
  }, [arrangeable, saved, drag]);

  const layout = useMemo(() => layoutNetwork(
    tasks.map((t) => ({ id: t.id, environment_id: t.environment_id, start: schedule.get(t.id)?.start ?? '' })),
    deps,
    order,
    lanes,
    overrides,
  ), [tasks, deps, order, lanes, schedule, overrides]);

  // One set of window listeners per drag, reading the live drag through the ref.
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (d.kind === 'link') {
        const box = innerRef.current?.getBoundingClientRect();
        if (!box) return;
        const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-node]')?.getAttribute('data-node');
        setDrag({
          ...d,
          at: { x: (e.clientX - box.left) / scale - pad, y: (e.clientY - box.top) / scale - pad },
          over: hit && Number(hit) !== d.from ? Number(hit) : null,
        });
        return;
      }
      const dx = (e.clientX - d.startX) / scale;
      const dy = (e.clientY - d.startY) / scale;
      if (d.kind === 'node') {
        const moved = d.moved || Math.hypot(e.clientX - d.startX, e.clientY - d.startY) > SLOP;
        const pos = { x: Math.max(0, snap(d.orig.x + dx, GRID)), y: Math.max(0, snap(d.orig.y + dy, GRID)) };
        setDrag({ ...d, moved, pos });
      } else {
        const r = { ...d.route };
        if (d.which === 'out') r.out = Math.max(4, snap(d.orig.out + dx, 2));
        if (d.which === 'in') r.in = Math.max(4, snap(d.orig.in - dx, 2));
        if (d.which === 'y') r.y = snap((d.orig.y ?? d.baseY) + dy, 2);
        setDrag({ ...d, route: r });
      }
    };
    const onUp = () => {
      const d = dragRef.current;
      setDrag(null);
      if (!d) return;
      if (d.kind === 'link') {
        if (d.over != null) onLink(d.from, d.over);
        return;
      }
      if (d.kind === 'node') {
        if (!d.moved) return;
        suppressClick.current = true;
        onMoveTask(d.id, d.pos);
      } else {
        onRouteEdge(d.from, d.to, d.route);
      }
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, scale, onMoveTask, onRouteEdge, onLink]);

  const critical = (id: number) => schedule.get(id)?.critical ?? false;
  const envOf = (id: number | null) => environments.find((e) => e.id === id);

  const fit = () => {
    const el = scrollRef.current;
    if (!el || !layout.width) return;
    const room = (el.clientWidth - 48) / layout.width;
    let pick = 0;
    ZOOMS.forEach((z, i) => { if (z <= room) pick = i; });
    setZoom(pick);
  };

  /**
   * Arrows walk the graph: right to a successor, left to a predecessor, up and down
   * within a column. Alt+arrows move the box itself, for arranging without a mouse.
   */
  const onNodeKey = (e: KeyboardEvent, id: number) => {
    if (!e.key.startsWith('Arrow')) return;
    const box = layout.nodes.get(id)!;
    e.preventDefault();
    if (e.altKey) {
      if (!arrangeable) return;
      const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key] ?? [0, 0];
      onMoveTask(id, { x: Math.max(0, snap(box.x, GRID) + step[0] * KEY_STEP), y: Math.max(0, snap(box.y, GRID) + step[1] * KEY_STEP) });
      return;
    }
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = deps.find((d) => d.predecessor_id === id)?.successor_id;
    else if (e.key === 'ArrowLeft') next = deps.find((d) => d.successor_id === id)?.predecessor_id;
    else {
      const column = [...layout.nodes.values()].filter((n) => n.col === box.col).sort((a, b) => a.y - b.y);
      const i = column.findIndex((n) => n.id === id) + (e.key === 'ArrowDown' ? 1 : -1);
      next = column[i]?.id;
    }
    if (next != null) nodeRefs.current.get(next)?.focus();
  };

  const startNodeDrag = (e: ReactPointerEvent, id: number) => {
    if (!arrangeable || e.button !== 0) return;
    const box = layout.nodes.get(id)!;
    setSelected(null);
    setDrag({ kind: 'node', id, startX: e.clientX, startY: e.clientY, orig: { x: box.x, y: box.y }, pos: { x: box.x, y: box.y }, moved: false });
  };

  const startLinkDrag = (e: ReactPointerEvent, id: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const box = layout.nodes.get(id)!;
    setSelected(null);
    setDrag({ kind: 'link', from: id, at: { x: box.x + NODE_W, y: box.y + NODE_H / 2 }, over: null });
  };

  const startHandleDrag = (e: ReactPointerEvent, key: string, which: 'out' | 'y' | 'in') => {
    e.stopPropagation();
    e.preventDefault();
    const edge = layout.edges.find((x) => edgeKey(x.from, x.to) === key);
    if (!edge) return;
    // Reshaping keeps the anchors the arrow is attached by.
    const kept = saved.routes.get(key);
    const orig = { ...routeOf(edge.points, layout.nodes.get(edge.from)!, layout.nodes.get(edge.to)!), from: kept?.from, to: kept?.to };
    const baseY = edge.points[edge.points.length - 1][1];
    setDrag({ kind: 'handle', key, from: edge.from, to: edge.to, which, startX: e.clientX, startY: e.clientY, orig, baseY, route: orig });
  };

  const arrange = () => {
    setSelected(null);
    onArrange(smartArrange(
      tasks.map((t) => ({ id: t.id, start: schedule.get(t.id)?.start ?? '', critical: critical(t.id) })),
      deps,
      order,
    ));
  };

  if (!tasks.length) return null;

  const width = layout.width + pad * 2;
  const height = layout.height + pad * 2;
  const hasArrangement = saved.positions.size > 0 || saved.routes.size > 0;
  const selectedEdge = selected ? layout.edges.find((x) => edgeKey(x.from, x.to) === selected) : undefined;

  /** Where the selected arrow's handles sit: one per run it can move. */
  const handles = (() => {
    if (!selectedEdge || !arrangeable) return [];
    const a = layout.nodes.get(selectedEdge.from)!;
    const b = layout.nodes.get(selectedEdge.to)!;
    const pts = selectedEdge.points;
    const r = drag?.kind === 'handle' && drag.key === selected ? drag.route : routeOf(pts, a, b);
    const x1 = a.x + NODE_W;
    const x2 = b.x;
    const y1 = pts[0][1];
    const y2 = pts[pts.length - 1][1];
    const outX = x1 + r.out;
    const list: { which: 'out' | 'y' | 'in'; x: number; y: number; label: string }[] = [
      { which: 'out', x: outX, y: (y1 + (r.y ?? y2)) / 2, label: 'Move the first run left or right' },
    ];
    if (r.y == null) {
      list.push({ which: 'y', x: (outX + x2) / 2, y: y2, label: 'Drag up or down to route this arrow round' });
    } else {
      const inX = x2 - r.in;
      list.push({ which: 'y', x: (outX + inX) / 2, y: r.y, label: 'Move the detour up or down' });
      list.push({ which: 'in', x: inX, y: (r.y + y2) / 2, label: 'Move the last run left or right' });
    }
    return list;
  })();

  return (
    <div
      className={`network${arrangeable ? ' is-arrangeable' : ''}${drag ? ' is-dragging' : ''}${drag?.kind === 'link' ? ' is-linking' : ''}`}
      onKeyDown={(e) => { if (e.key === 'Escape') setSelected(null); }}
    >
      <div className="network-zoom" role="group" aria-label="Layout and zoom">
        {selectedEdge && saved.routes.has(selected!) && (
          <button type="button" className="btn quiet" onClick={() => { onRouteEdge(selectedEdge.from, selectedEdge.to, null); }}>
            Reset arrow
          </button>
        )}
        {arrangeable && onUndoArrange && (
          <button type="button" className="btn quiet" onClick={() => { setSelected(null); onUndoArrange(); }}>
            Undo arrange
          </button>
        )}
        {arrangeable && (
          <button
            type="button"
            className="btn quiet"
            onClick={arrange}
            title="Line the boxes up on a grid and route every arrow clear of the others. Undo puts back what was there."
          >
            Smart Arrange
          </button>
        )}
        {hasArrangement && arrangeable && (
          <button type="button" className="btn quiet" onClick={() => { setSelected(null); onResetLayout(); }}>
            Reset layout
          </button>
        )}
        <button type="button" className="btn quiet" disabled={zoom === 0} onClick={() => setZoom((z) => z - 1)} aria-label="Zoom out">−</button>
        <button type="button" className="btn quiet" onClick={fit}>Fit</button>
        <button type="button" className="btn quiet" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)} aria-label="Zoom in">+</button>
      </div>

      <div className="network-scroll" ref={scrollRef}>
        <div className="network-canvas" style={{ width: width * scale, height: height * scale }}>
          <div
            ref={innerRef}
            className="network-inner"
            style={{ width, height, transform: `scale(${scale})` }}
            // A press on empty canvas puts a selected arrow down.
            onPointerDown={(e) => { if (!(e.target as Element).closest('.network-node, .network-edge-hit, .network-handle')) setSelected(null); }}
          >
            {layout.lanes.map((lane) => {
              const env = envOf(lane.id);
              return (
                <div
                  key={lane.id ?? 'none'}
                  className="network-lane"
                  style={{
                    top: pad + lane.y - 6, height: lane.height,
                    ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'var(--rule)',
                  } as CSSProperties}
                >
                  <span className="network-lane-label">{lane.name}</span>
                </div>
              );
            })}

            <svg className="network-edges" width={width} height={height}>
              <defs>
                <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className="network-arrow" />
                </marker>
                <marker id="arrow-critical" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className="network-arrow is-critical" />
                </marker>
                <marker id="arrow-related" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className="network-arrow is-related" />
                </marker>
              </defs>
              <g transform={`translate(${pad},${pad})`}>
                {layout.edges.map((edge) => {
                  const key = edgeKey(edge.from, edge.to);
                  const onPath = critical(edge.from) && critical(edge.to);
                  const isSelected = key === selected;
                  const related = isSelected || (focused != null && (edge.from === focused || edge.to === focused));
                  const d = roundedPath(edge.points);
                  const name = (id: number) => byId.get(id)?.name ?? '';
                  return (
                    <g key={key}>
                      <path
                        d={d}
                        pathLength={1}
                        aria-hidden="true"
                        className={[
                          'network-edge',
                          onPath ? 'is-critical' : '',
                          criticalOnly && !onPath ? 'is-dim' : '',
                          related ? 'is-related' : focused != null || selected != null ? 'is-faint' : '',
                          isSelected ? 'is-selected' : '',
                        ].filter(Boolean).join(' ')}
                        markerEnd={`url(#${onPath ? 'arrow-critical' : related ? 'arrow-related' : 'arrow'})`}
                      />
                      {arrangeable && (
                        // A wide, invisible twin of the arrow, so it is easy to pick up.
                        <path
                          d={d}
                          className="network-edge-hit"
                          onPointerDown={(e) => { e.stopPropagation(); setSelected(key); }}
                        >
                          <title>{`${name(edge.from)} → ${name(edge.to)}. Click to reshape.`}</title>
                        </path>
                      )}
                    </g>
                  );
                })}
                {drag?.kind === 'link' && (() => {
                  const a = layout.nodes.get(drag.from)!;
                  return <line className="network-rubber" x1={a.x + NODE_W} y1={a.y + NODE_H / 2} x2={drag.at.x} y2={drag.at.y} />;
                })()}
                {handles.map((h) => (
                  <rect
                    key={h.which}
                    className={`network-handle is-${h.which === 'y' ? 'vertical' : 'horizontal'}`}
                    x={h.x - 6}
                    y={h.y - 6}
                    width={12}
                    height={12}
                    rx={2}
                    onPointerDown={(e) => startHandleDrag(e, selected!, h.which)}
                  >
                    <title>{h.label}</title>
                  </rect>
                ))}
              </g>
            </svg>

            {order.filter((id) => layout.nodes.has(id)).map((id) => {
              const t = byId.get(id)!;
              const s = schedule.get(id);
              const box = layout.nodes.get(id)!;
              const env = envOf(t.environment_id);
              const isCritical = critical(id);
              const milestone = t.duration === 0;
              return [
                <button
                  key={id}
                  ref={(el) => { if (el) nodeRefs.current.set(id, el); else nodeRefs.current.delete(id); }}
                  type="button"
                  className={[
                    'network-node',
                    isCritical ? 'is-critical' : '',
                    t.status === 'done' ? 'is-done' : '',
                    criticalOnly && !isCritical ? 'is-dim' : '',
                    drag?.kind === 'node' && drag.id === id && drag.moved ? 'is-moving' : '',
                    drag?.kind === 'link' && drag.over === id ? 'is-link-target' : '',
                  ].filter(Boolean).join(' ')}
                  data-node={id}
                  style={{
                    left: pad + box.x, top: pad + box.y, width: NODE_W, height: NODE_H,
                    ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'transparent',
                  } as CSSProperties}
                  onPointerDown={(e) => startNodeDrag(e, id)}
                  onClick={() => {
                    if (suppressClick.current) { suppressClick.current = false; return; }
                    onOpenTask(id);
                  }}
                  onKeyDown={(e) => onNodeKey(e, id)}
                  onPointerEnter={() => setFocused(id)}
                  onPointerLeave={() => setFocused((f) => (f === id ? null : f))}
                  onFocus={() => setFocused(id)}
                  onBlur={() => setFocused((f) => (f === id ? null : f))}
                  aria-label={[
                    t.name,
                    env ? `on ${env.name}` : '',
                    s ? `${formatDate(s.start)} to ${formatDate(s.end)}` : '',
                    s ? `${s.total_float} days float` : '',
                    isCritical ? 'critical' : '',
                    t.status === 'done' ? 'done' : '',
                  ].filter(Boolean).join(', ')}
                >
                  <span className="nn-row nn-early">
                    <span>{s ? formatDate(s.start) : '—'}</span>
                    <span className="nn-dur">{milestone ? 'milestone' : `${t.duration}d`}</span>
                    <span>{s ? formatDate(s.end) : '—'}</span>
                  </span>
                  <span className="nn-name">
                    {t.status === 'done' && <span className="nn-done" aria-hidden="true">✓ </span>}
                    {t.name}
                  </span>
                  <span className="nn-row nn-late">
                    <span>{s ? formatDate(s.late_start) : '—'}</span>
                    <span className="nn-float">{s ? (isCritical ? 'critical' : `${s.total_float}d float`) : ''}</span>
                    <span>{s ? formatDate(s.late_end) : '—'}</span>
                  </span>
                </button>,
                <span
                  key={`port${id}`}
                  className={`network-port${focused === id ? ' is-shown' : ''}${drag?.kind === 'link' && drag.from === id ? ' is-active' : ''}`}
                  style={{ left: pad + box.x + NODE_W - 6, top: pad + box.y + NODE_H / 2 - 6 }}
                  onPointerDown={(e) => startLinkDrag(e, id)}
                  onPointerEnter={() => setFocused(id)}
                  onPointerLeave={() => setFocused((f) => (f === id ? null : f))}
                  title={`Drag onto another task to make it come after ${t.name}`}
                  aria-hidden="true"
                />,
              ];
            })}
          </div>
        </div>
      </div>

      {drag?.kind === 'link' && (
        <div className="network-link-readout" role="status">
          {drag.over != null
            ? `${byId.get(drag.over)?.name} comes after ${byId.get(drag.from)?.name}`
            : 'Drop on a task to link it after this one'}
        </div>
      )}

      <p className="network-key">
        Top row: early start, duration, early finish. Bottom row: late start, float, late finish.
        Heavy boxes and red arrows are the critical path. Point at a task to pick out its own arrows.
        Drag the dot on a box's right edge onto another box to make that task come after it.{' '}
        {arrangeable
          ? 'Drag a box to move it (Alt+arrows with the keyboard). Click an arrow, then drag its square handles to reshape it.'
          : 'Turn off Show environments to arrange boxes and arrows by hand.'}
      </p>
    </div>
  );
}
