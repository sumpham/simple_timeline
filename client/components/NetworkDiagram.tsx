import { useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import type { Environment, Task, TaskDependency, TaskSchedule } from '../../shared/types.ts';
import { formatDate } from '../layout.ts';
import { layoutNetwork, NODE_H, NODE_W, roundedPath, type LayoutLane } from '../network.ts';
import { ENV_COLOR } from './Board.tsx';

/** Zoom runs in fixed steps, like the board's grains, never continuously. */
const ZOOMS = [0.5, 0.65, 0.8, 1, 1.2];

/**
 * Activity-on-node network. Each node is the classic scheduling box: early start,
 * duration and early finish on top; late start, float and late finish beneath.
 * The critical path is the one bold thing here, drawn in heavy ink rather than
 * red, because red on this app means a double-booking and nothing else.
 */
export function NetworkDiagram({
  tasks, deps, schedule, order, environments, showEnvironments, criticalOnly, onOpenTask,
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
}) {
  const [zoom, setZoom] = useState(3);
  const scrollRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<number, HTMLButtonElement>());

  const byId = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);

  const lanes = useMemo<LayoutLane[] | undefined>(() => {
    if (!showEnvironments) return undefined;
    const used = new Set(tasks.map((t) => t.environment_id));
    // Board order, only the environments this plan touches, and the unbooked work last.
    const list: LayoutLane[] = environments.filter((e) => used.has(e.id)).map((e) => ({ id: e.id, name: e.name }));
    if (used.has(null)) list.push({ id: null, name: 'No environment' });
    return list;
  }, [showEnvironments, tasks, environments]);

  const layout = useMemo(() => layoutNetwork(
    tasks.map((t) => ({ id: t.id, environment_id: t.environment_id, start: schedule.get(t.id)?.start ?? '' })),
    deps,
    order,
    lanes,
  ), [tasks, deps, order, lanes, schedule]);

  const critical = (id: number) => schedule.get(id)?.critical ?? false;
  const envOf = (id: number | null) => environments.find((e) => e.id === id);
  const scale = ZOOMS[zoom];

  const fit = () => {
    const el = scrollRef.current;
    if (!el || !layout.width) return;
    const room = (el.clientWidth - 48) / layout.width;
    let pick = 0;
    ZOOMS.forEach((z, i) => { if (z <= room) pick = i; });
    setZoom(pick);
  };

  /** Arrows walk the graph: right to a successor, left to a predecessor, up and down within a column. */
  const onNodeKey = (e: KeyboardEvent, id: number) => {
    const box = layout.nodes.get(id)!;
    let next: number | undefined;
    if (e.key === 'ArrowRight') next = deps.find((d) => d.predecessor_id === id)?.successor_id;
    else if (e.key === 'ArrowLeft') next = deps.find((d) => d.successor_id === id)?.predecessor_id;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const column = [...layout.nodes.values()].filter((n) => n.col === box.col).sort((a, b) => a.y - b.y);
      const i = column.findIndex((n) => n.id === id) + (e.key === 'ArrowDown' ? 1 : -1);
      next = column[i]?.id;
    } else return;
    e.preventDefault();
    if (next != null) nodeRefs.current.get(next)?.focus();
  };

  if (!tasks.length) return null;

  const pad = 24;
  const width = layout.width + pad * 2;
  const height = layout.height + pad * 2;

  return (
    <div className="network">
      <div className="network-zoom" role="group" aria-label="Zoom">
        <button type="button" className="btn quiet" disabled={zoom === 0} onClick={() => setZoom((z) => z - 1)} aria-label="Zoom out">−</button>
        <button type="button" className="btn quiet" onClick={fit}>Fit</button>
        <button type="button" className="btn quiet" disabled={zoom === ZOOMS.length - 1} onClick={() => setZoom((z) => z + 1)} aria-label="Zoom in">+</button>
      </div>

      <div className="network-scroll" ref={scrollRef}>
        <div className="network-canvas" style={{ width: width * scale, height: height * scale }}>
          <div
            className="network-inner"
            style={{ width, height, transform: `scale(${scale})` }}
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

            <svg className="network-edges" width={width} height={height} aria-hidden="true">
              <defs>
                <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className="network-arrow" />
                </marker>
                <marker id="arrow-critical" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
                  <path d="M0,0 L8,4 L0,8 z" className="network-arrow is-critical" />
                </marker>
              </defs>
              <g transform={`translate(${pad},${pad})`}>
                {layout.edges.map((edge) => {
                  const onPath = critical(edge.from) && critical(edge.to);
                  return (
                    <path
                      key={`${edge.from}-${edge.to}`}
                      d={roundedPath(edge.points)}
                      pathLength={1}
                      className={`network-edge${onPath ? ' is-critical' : ''}${criticalOnly && !onPath ? ' is-dim' : ''}`}
                      markerEnd={`url(#${onPath ? 'arrow-critical' : 'arrow'})`}
                    />
                  );
                })}
              </g>
            </svg>

            {order.filter((id) => layout.nodes.has(id)).map((id) => {
              const t = byId.get(id)!;
              const s = schedule.get(id);
              const box = layout.nodes.get(id)!;
              const env = envOf(t.environment_id);
              const isCritical = critical(id);
              const milestone = t.duration === 0;
              return (
                <button
                  key={id}
                  ref={(el) => { if (el) nodeRefs.current.set(id, el); else nodeRefs.current.delete(id); }}
                  type="button"
                  className={[
                    'network-node',
                    isCritical ? 'is-critical' : '',
                    t.status === 'done' ? 'is-done' : '',
                    criticalOnly && !isCritical ? 'is-dim' : '',
                  ].filter(Boolean).join(' ')}
                  style={{
                    left: pad + box.x, top: pad + box.y, width: NODE_W, height: NODE_H,
                    ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'transparent',
                  } as CSSProperties}
                  onClick={() => onOpenTask(id)}
                  onKeyDown={(e) => onNodeKey(e, id)}
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
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <p className="network-key">
        Top row: early start, duration, early finish. Bottom row: late start, float, late finish.
        Heavy boxes and arrows are the critical path.
      </p>
    </div>
  );
}
