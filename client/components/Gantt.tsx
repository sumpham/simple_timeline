import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type {
  BookingView, Conflict, Environment, ISODate, LinkType, Resource, Task, TaskDependency, TaskSchedule,
} from '../../shared/types.ts';
import type { OutlineRow } from '../../shared/wbs.ts';
import { occupancyByDay } from '../../shared/conflicts.ts';
import { snapToWorkingDay } from '../../shared/dates.ts';
import { formatDate, formatRange } from '../layout.ts';
import {
  chainOf, dayColumn, DAY_WIDTH, draggedFinish, draggedStart, draggedStartEdge, finishFields, finishVariance, ganttDays, ganttScale,
  gridLines, headerBands, minWeeksFor, spanX, startEdgeFields, startFields, type GanttScale, type Zoom,
} from '../gantt.ts';
import type { TaskInput } from '../api.ts';
import { ENV_COLOR } from './Board.tsx';

/**
 * The task table's chart: one bar per row, beside the row it draws.
 *
 * Rows are not laid out here. The table measures its own rows (`RowBox`) and
 * the chart draws at those heights, so a row that grows never drifts, and a
 * row the table hides (filtered, or under a collapsed summary) is not drawn.
 *
 * Editing on the chart goes through the same doors as the table: a dragged
 * start becomes `startFields`, a dragged finish `finishFields`, a dragged left
 * end `startEdgeFields`, and the drop calls the plan's own setStart / setFinish
 * / setStartEdge. While dragging, the parent's
 * `preview` runs the shared scheduler and conflict engine on the would-be plan,
 * so successors move and a new double-booking is named before anything is saved.
 */

export type RowBox = { top: number; height: number };

export type GanttShow = {
  float: boolean;
  labels: boolean;
  baseline: boolean;
  bookings: boolean;
  strip: boolean;
};

export type GanttPreview = {
  schedule: ReadonlyMap<number, TaskSchedule>;
  /** The team's bookings and double-bookings as the change would leave them. */
  bookings: readonly BookingView[];
  conflicts: readonly Conflict[];
  /** Double-bookings the change would add, for the readout. */
  added: readonly { env_name: string; projects: string[] }[];
};

export type StripData = {
  environments: readonly Environment[];
  bookings: readonly BookingView[];
  conflicts: readonly Conflict[];
};

export type GanttCommand = { kind: 'today' | 'start'; n: number };

export const STRIP_HEAD = 24;
export const STRIP_LANE = 26;

const BAR_H = 14;
const DIAMOND = 7;
const SLOP = 4;

/** Move keeps the length; resize moves the finish; resize-start moves the start and keeps the finish. */
type BarMode = 'move' | 'resize' | 'resize-start';
type DragMode = BarMode | 'link';

type Shape = { x0: number; x1: number; mid: number; milestone: boolean; summary: boolean };

type Drag = {
  id: number;
  mode: DragMode;
  pointer: number;
  x: number;
  y: number;
  moved: boolean;
  cols: number;
  /** Where the pointer is, in chart coordinates, for the link's rubber band. */
  px: number;
  py: number;
  over: number | null;
};

type Live = { id: number; fields: TaskInput; date: ISODate; mode: BarMode; result: GanttPreview | null };

export function Gantt({
  tasks, outline, deps, schedule, environments, holidays, today, start, target, rows, head, height, zoom, show,
  baseline, bookings, progress, people, strip, command, preview, onOpen, onSetStart, onSetFinish, onSetStartEdge, onLink, onLinkChange, onRelease,
}: {
  tasks: readonly Task[];
  outline: ReadonlyMap<number, OutlineRow>;
  deps: readonly TaskDependency[];
  schedule: ReadonlyMap<number, TaskSchedule>;
  environments: readonly Environment[];
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  /** The project's own start and target, so the chart spans them even before tasks do. */
  start: ISODate | null;
  target: ISODate | null;
  /** Row geometry, measured from the table, from the top of the table. */
  rows: ReadonlyMap<number, RowBox>;
  head: number;
  height: number;
  zoom: Zoom;
  show: GanttShow;
  baseline: ReadonlyMap<number, { start: ISODate; end: ISODate }>;
  bookings: readonly BookingView[];
  progress: ReadonlyMap<number, number>;
  /** Every person by id, for the names after a bar. */
  people: ReadonlyMap<number, Resource>;
  strip: StripData | null;
  command: GanttCommand | null;
  preview: (t: Task, fields: TaskInput) => GanttPreview | null;
  onOpen: (id: number) => void;
  onSetStart: (t: Task, date: ISODate) => Promise<boolean>;
  onSetFinish: (t: Task, date: ISODate) => Promise<boolean>;
  /** A new start with the finish kept where it is. */
  onSetStartEdge: (t: Task, date: ISODate) => Promise<boolean>;
  onLink: (predecessorId: number, successorId: number) => Promise<unknown>;
  onLinkChange: (dep: TaskDependency, next: { type: LinkType; lag: number } | null) => Promise<unknown>;
  onRelease: (b: BookingView) => Promise<void>;
}) {
  const dayW = DAY_WIDTH[zoom];
  // The scale follows the saved plan, never a drag, so the ground does not move under the pointer.
  const scale = useMemo(() => ganttScale([
    start, target,
    ...[...schedule.values()].flatMap((s) => [s.start, s.end, s.late_end, s.deadline]),
    ...[...baseline.values()].flatMap((b) => [b.start, b.end]),
    ...bookings.flatMap((b) => [b.start_date, b.end_date]),
  ], minWeeksFor(zoom)), [schedule, start, target, baseline, bookings, zoom]);
  const days = useMemo(() => (scale ? ganttDays(scale) : []), [scale]);
  const header = useMemo(() => headerBands(days, zoom), [days, zoom]);
  const grid = useMemo(() => gridLines(days, zoom), [days, zoom]);
  const ref = useRef<HTMLDivElement>(null);

  const [drag, setDrag] = useState<Drag | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [live, setLive] = useState<Live | null>(null);
  const liveRef = useRef<Live | null>(null);
  liveRef.current = live;
  const [trace, setTrace] = useState<number | null>(null);
  const [linkEdit, setLinkEdit] = useState<{ dep: TaskDependency; x: number; y: number } | null>(null);
  const keyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keyCols = useRef<{ id: number; mode: BarMode; cols: number } | null>(null);

  const scroller = () => ref.current?.parentElement ?? null;

  // Open on this week: a plan that began months ago should not open on its first day.
  const opened = useRef<ISODate | null>(null);
  useEffect(() => {
    const el = scroller();
    if (!scale || !el || opened.current === scale.start) return;
    opened.current = scale.start;
    if (today > scale.start) el.scrollLeft = Math.max(0, dayColumn(scale, today, 'start') * dayW - 5 * dayW);
  }, [scale, today, dayW]);

  // Changing zoom keeps the same day at the left edge.
  const lastDayW = useRef(dayW);
  useLayoutEffect(() => {
    const el = scroller();
    if (el && lastDayW.current !== dayW) el.scrollLeft = (el.scrollLeft / lastDayW.current) * dayW;
    lastDayW.current = dayW;
  }, [dayW]);

  useEffect(() => {
    const el = scroller();
    if (!command || !scale || !el) return;
    const col = command.kind === 'today' ? dayColumn(scale, today, 'start') : start ? dayColumn(scale, start, 'start') : 0;
    el.scrollTo({ left: Math.max(0, col * dayW - 5 * dayW), behavior: 'smooth' });
  }, [command]);

  useEffect(() => () => { if (keyTimer.current) clearTimeout(keyTimer.current); }, []);

  if (!scale) return <div className="gantt" aria-hidden="true" />;

  const width = days.length * dayW;
  const bodyH = Math.max(0, height - head);
  const shown = live?.result?.schedule ?? schedule;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const envOf = (id: number | null) => environments.find((e) => e.id === id);

  /** Each visible task's drawn shape, in body coordinates. */
  const shapes = new Map<number, Shape>();
  for (const t of tasks) {
    const s = shown.get(t.id);
    const r = rows.get(t.id);
    if (!s || !r || r.height === 0) continue;
    const mid = r.top - head + r.height / 2;
    const summary = !!outline.get(t.id)?.summary;
    if (!summary && t.duration === 0) {
      // A milestone is the end of its day, where its predecessor finishes.
      const cx = (dayColumn(scale, s.end, 'end') + 1) * dayW;
      shapes.set(t.id, { x0: cx - DIAMOND, x1: cx + DIAMOND, mid, milestone: true, summary });
    } else {
      shapes.set(t.id, { ...spanX(scale, s.start, s.end, dayW), mid, milestone: false, summary });
    }
  }

  const colX = (d: ISODate, edge: 'start' | 'end') => (dayColumn(scale, d, edge) + (edge === 'end' ? 1 : 0)) * dayW;
  const todayCol = today >= scale.start ? dayColumn(scale, today, 'start') : -1;
  const todayX = todayCol >= 0 && todayCol < days.length ? todayCol * dayW : null;
  const targetX = target ? colX(target, 'end') : null;
  const chain = trace != null && !drag?.moved ? chainOf(trace, deps) : null;

  // ------------------------------------------------------------ gestures

  const toChart = (clientX: number, clientY: number) => {
    const box = ref.current!.getBoundingClientRect();
    return { x: clientX - box.left, y: clientY - box.top };
  };

  const runPreview = (t: Task, mode: BarMode, cols: number) => {
    const s = schedule.get(t.id);
    if (!s) return;
    let date: ISODate;
    let fields: TaskInput | null;
    if (mode === 'move') {
      date = draggedStart(scale, s.start, cols, holidays);
      fields = startFields(t, date);
    } else if (mode === 'resize-start') {
      date = draggedStartEdge(scale, s.start, s.end, cols, holidays);
      fields = startEdgeFields(t, date, s.end, holidays);
    } else {
      date = draggedFinish(scale, s.start, s.end, cols, holidays);
      fields = finishFields(t, s.start, date, holidays);
    }
    if (!fields) return;
    setLive({ id: t.id, fields, date, mode, result: preview(t, fields) });
  };

  /** Save through the plan's own setStart / setFinish; the preview stays up until the answer lands. */
  const commit = async (t: Task, l: Live) => {
    const s = schedule.get(t.id);
    const unchanged = l.mode === 'resize' ? s?.end === l.date : s?.start === l.date;
    if (!unchanged) {
      await (l.mode === 'move' ? onSetStart(t, l.date) : l.mode === 'resize' ? onSetFinish(t, l.date) : onSetStartEdge(t, l.date));
    }
    setLive(null);
  };

  const onBarPointerDown = (e: ReactPointerEvent<SVGGElement>, t: Task) => {
    if (e.button !== 0 || dragRef.current) return;
    const handle = (e.target as Element).closest('[data-handle]')?.getAttribute('data-handle');
    const summary = !!outline.get(t.id)?.summary;
    const mode: DragMode = handle === 'link' ? 'link'
      : (handle === 'resize' || handle === 'resize-start') && !summary ? handle : 'move';
    const p = toChart(e.clientX, e.clientY);
    const d: Drag = { id: t.id, mode, pointer: e.pointerId, x: e.clientX, y: e.clientY, moved: false, cols: 0, px: p.x, py: p.y, over: null };
    dragRef.current = d;
    setDrag(d);
    (e.currentTarget.ownerSVGElement ?? e.currentTarget).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointer) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
    const t = byId.get(d.id)!;
    const summary = !!outline.get(t.id)?.summary;
    const next: Drag = { ...d, moved: true };
    if (d.mode === 'link') {
      const p = toChart(e.clientX, e.clientY);
      const hit = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-bar]')?.getAttribute('data-bar');
      next.px = p.x;
      next.py = p.y;
      next.over = hit && Number(hit) !== d.id ? Number(hit) : null;
    } else if (!summary) {
      // A summary's dates are its tasks'; it cannot be dragged, only opened.
      const cols = Math.round(dx / dayW);
      if (cols !== d.cols || !d.moved) runPreview(t, d.mode, cols);
      next.cols = cols;
    }
    dragRef.current = next;
    setDrag(next);
  };

  const endDrag = (e: ReactPointerEvent<SVGSVGElement>, cancelled: boolean) => {
    const d = dragRef.current;
    if (!d || e.pointerId !== d.pointer) return;
    dragRef.current = null;
    setDrag(null);
    const t = byId.get(d.id)!;
    if (cancelled) { setLive(null); return; }
    if (!d.moved) { setLive(null); onOpen(d.id); return; }
    if (d.mode === 'link') {
      if (d.over != null) void onLink(d.id, d.over);
      return;
    }
    const l = liveRef.current;
    if (l && l.id === d.id) void commit(t, l);
    else setLive(null);
  };

  /** Alt+arrows mirror the gestures and settle into one write, like the board's bars. */
  const onBarKey = (e: KeyboardEvent<SVGGElement>, t: Task) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(t.id); return; }
    if (e.key === 'Escape' && keyCols.current) {
      if (keyTimer.current) clearTimeout(keyTimer.current);
      keyCols.current = null;
      setLive(null);
      return;
    }
    if (!e.altKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || outline.get(t.id)?.summary) return;
    e.preventDefault();
    const mode = e.shiftKey ? 'resize' : 'move';
    const prev = keyCols.current?.id === t.id && keyCols.current.mode === mode ? keyCols.current.cols : 0;
    const cols = prev + (e.key === 'ArrowLeft' ? -1 : 1);
    keyCols.current = { id: t.id, mode, cols };
    runPreview(t, mode, cols);
    if (keyTimer.current) clearTimeout(keyTimer.current);
    keyTimer.current = setTimeout(() => {
      keyCols.current = null;
      const l = liveRef.current;
      if (l && l.id === t.id) void commit(t, l);
    }, 700);
  };

  // ------------------------------------------------------------ drawing

  const linkDrawn = (d: TaskDependency) => {
    const p = shapes.get(d.predecessor_id);
    const s = shapes.get(d.successor_id);
    if (!p || !s) return null;
    const critical = !!shown.get(d.predecessor_id)?.critical && !!shown.get(d.successor_id)?.critical;
    const faded = chain && !(chain.has(d.predecessor_id) && chain.has(d.successor_id));
    const path = linkPath(p, s, d.type ?? 'FS');
    return (
      <g key={`${d.predecessor_id}-${d.successor_id}`} className={`gantt-link-g${faded ? ' is-faded' : ''}`}>
        <path className={`gantt-link${critical ? ' is-critical' : ''}`} d={path} markerEnd={`url(#gantt-arrow${critical ? '-critical' : ''})`} />
        <path
          className="gantt-link-hit"
          d={path}
          onClick={(e) => {
            const p2 = toChart(e.clientX, e.clientY);
            setLinkEdit({ dep: d, x: p2.x, y: p2.y });
          }}
        >
          <title>{`${linkSentence(byId.get(d.successor_id)?.name ?? '', byId.get(d.predecessor_id)?.name ?? '', d)}. Click to change.`}</title>
        </path>
      </g>
    );
  };

  const barFor = (t: Task) => {
    const g = shapes.get(t.id);
    const s = shown.get(t.id);
    if (!g || !s) return null;
    const env = envOf(t.environment_id);
    const pct = progress.get(t.id) ?? 0;
    const faded = chain && !chain.has(t.id);
    const moving = live?.id === t.id || drag?.id === t.id;
    const cls = [
      'gantt-task',
      g.summary ? 'is-summary' : g.milestone ? 'is-milestone' : '',
      s.critical ? 'is-critical' : '',
      t.status === 'done' ? 'is-done' : '',
      env || g.summary ? '' : 'is-unbooked',
      faded ? 'is-faded' : '',
      moving ? 'is-moving' : '',
      drag?.mode === 'link' && drag.over === t.id ? 'is-link-target' : '',
    ].filter(Boolean).join(' ');
    const when = g.milestone ? formatDate(s.end) : formatRange(s.start, s.end);
    const label = `${t.name}, ${when}${s.critical ? ', critical' : `, ${s.total_float} days float`}${pct ? `, ${pct}% done` : ''}`;
    const top = g.mid - BAR_H / 2;
    return (
      <g
        key={t.id}
        className={cls}
        data-bar={t.id}
        role="button"
        tabIndex={0}
        aria-label={`${label}. Enter opens it${g.summary ? '' : '; Alt+arrows move it, Alt+Shift+arrows change its length'}.`}
        style={{ ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'transparent' } as CSSProperties}
        onPointerDown={(e) => onBarPointerDown(e, t)}
        onPointerEnter={() => setTrace(t.id)}
        onPointerLeave={() => setTrace((x) => (x === t.id ? null : x))}
        onFocus={() => setTrace(t.id)}
        onBlur={() => setTrace((x) => (x === t.id ? null : x))}
        onKeyDown={(e) => onBarKey(e, t)}
      >
        <title>{label}</title>
        {g.summary ? (
          <>
            <path className="gantt-summary" d={summaryPath(g)} />
            {pct > 0 && <rect className="gantt-progress" x={g.x0} y={g.mid - 4} width={Math.max(0, (g.x1 - g.x0) * pct / 100)} height={4} />}
          </>
        ) : g.milestone ? (
          <path className="gantt-shape" d={`M${g.x0 + DIAMOND} ${g.mid - DIAMOND} l${DIAMOND} ${DIAMOND} l${-DIAMOND} ${DIAMOND} l${-DIAMOND} ${-DIAMOND}z`} />
        ) : (
          <>
            <rect className="gantt-shape" x={g.x0 + 1} y={top} width={Math.max(2, g.x1 - g.x0 - 2)} height={BAR_H} rx={2} />
            {pct > 0 && (
              <rect className="gantt-progress" x={g.x0 + 1} y={top + BAR_H - 5} width={Math.max(0, (g.x1 - g.x0 - 2) * pct / 100)} height={4} rx={1} />
            )}
            <rect className="gantt-grip" data-handle="resize-start" x={g.x0} y={top} width={7} height={BAR_H}>
              <title>Drag to change the start; the finish stays</title>
            </rect>
            <rect className="gantt-grip" data-handle="resize" x={g.x1 - 6} y={top} width={7} height={BAR_H}>
              <title>Drag to change the finish</title>
            </rect>
          </>
        )}
        <circle className="gantt-link-handle" data-handle="link" cx={g.x1 + (g.milestone ? 3 : 5)} cy={g.mid} r={4} />
      </g>
    );
  };

  const labelFor = (t: Task) => {
    const g = shapes.get(t.id);
    const s = shown.get(t.id);
    if (!g || !s) return null;
    const b = baseline.get(t.id);
    const variance = show.baseline && b ? finishVariance(b.end, s.end, holidays) : 0;
    if (!show.labels && !variance) return null;
    const who = (t.resource_ids ?? []).map((id) => people.get(id)?.name).filter((n): n is string => !!n);
    const tail = show.float && !s.critical && s.total_float > 0 && !g.summary ? colX(s.late_end, 'end') : g.x1;
    return (
      <text key={`l${t.id}`} className={`gantt-label${g.summary ? ' is-summary' : ''}${chain && !chain.has(t.id) ? ' is-faded' : ''}`} x={Math.max(g.x1, tail) + 9} y={g.mid + 4}>
        {show.labels && t.name}
        {show.labels && who.length > 0 && (
          <tspan className="gantt-label-who">
            {' · '}{who.length > 2 ? `${who[0]} +${who.length - 1}` : who.join(', ')}
            <title>{`${g.summary ? 'Owner' : 'Who'}: ${who.join(', ')}`}</title>
          </tspan>
        )}
        {s.deadline_slack != null && s.deadline_slack < 0 && (
          <tspan className="gantt-variance"> {-s.deadline_slack}d late<title>{`Finishes ${-s.deadline_slack} working day${s.deadline_slack === -1 ? '' : 's'} after its deadline of ${formatDate(s.deadline!)}`}</title></tspan>
        )}
        {variance !== 0 && (
          <tspan className="gantt-variance"> {variance > 0 ? '+' : '−'}{Math.abs(variance)}d<title>{`Finishes ${Math.abs(variance)} working day${Math.abs(variance) === 1 ? '' : 's'} ${variance > 0 ? 'later' : 'sooner'} than the baseline`}</title></tspan>
        )}
      </text>
    );
  };

  const releaseDone = new Set<number>();
  const bookingBands = show.bookings && bookings.flatMap((b) => {
    if (!b.tasks?.length) return [];
    const env = envOf(b.environment_id);
    const { x0, x1 } = spanX(scale, b.start_date, b.end_date, dayW);
    const rowsOf = b.tasks.map((x) => ({ id: x.id, r: rows.get(x.id) })).filter((x) => x.r && x.r.height > 0);
    const last = rowsOf.reduce<typeof rowsOf[number] | null>((m, x) => (!m || x.r!.top > m.r!.top ? x : m), null);
    return rowsOf.map(({ id, r }) => {
      const mid = r!.top - head + r!.height / 2;
      const release = b.release_from && last?.id === id && !releaseDone.has(b.id) ? b.release_from : null;
      if (release) releaseDone.add(b.id);
      return (
        <g key={`b${b.id}-${id}`} style={{ ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'var(--rule)' } as CSSProperties}>
          <rect className={`gantt-booking${b.auto ? ' is-auto' : ''}`} x={x0} y={mid - 11} width={Math.max(2, x1 - x0)} height={22}>
            <title>{`${b.env_name} booked ${formatRange(b.start_date, b.end_date)}${b.auto ? ', made by tasks' : ''}`}</title>
          </rect>
          {release && release <= b.end_date && (
            <g className="gantt-release" onClick={() => void onRelease(b)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') void onRelease(b); }}
              aria-label={`Tasks done. Release ${b.env_name} from ${formatDate(release)}`}>
              <rect x={colX(release, 'start')} y={mid - 11} width={Math.max(2, x1 - colX(release, 'start'))} height={22} />
              <line x1={colX(release, 'start') + 0.5} x2={colX(release, 'start') + 0.5} y1={mid - 11} y2={mid + 11} />
              <title>{`Tasks done. Release ${b.env_name} from ${formatDate(release)}`}</title>
            </g>
          )}
        </g>
      );
    });
  });

  const readout = (() => {
    if (drag?.mode === 'link' && drag.moved) {
      const target = drag.over != null ? byId.get(drag.over) : null;
      return { x: drag.px + 12, y: drag.py + 10, lines: [target ? `${target.name} comes after ${byId.get(drag.id)?.name}` : 'Drop on a task to link it after this one'], alarm: [] as string[] };
    }
    if (!live) return null;
    const g = shapes.get(live.id);
    const s = live.result?.schedule.get(live.id);
    if (!g || !s) return null;
    const t = byId.get(live.id)!;
    const lines = [live.mode === 'move'
      ? `${t.name}: ${formatRange(s.start, s.end)}`
      : live.mode === 'resize-start'
        ? `${t.name}: starts ${formatDate(s.start)}${live.fields.duration != null ? `, ${live.fields.duration} working day${live.fields.duration === 1 ? '' : 's'}` : ''}`
        : `${t.name}: ends ${formatDate(s.end)}${live.fields.duration != null ? `, ${live.fields.duration} working day${live.fields.duration === 1 ? '' : 's'}` : ''}`];
    if (live.mode !== 'resize' && s.start !== live.date && t.duration > 0) lines.push(`Held to ${formatDate(s.start)} by what it waits for`);
    const alarm = (live.result?.added ?? []).map((c) => `Double-books ${c.env_name} with ${c.projects.join(' and ')}`);
    return { x: g.x1 + 14, y: g.mid - BAR_H + head, lines, alarm };
  })();

  return (
    <div className="gantt" ref={ref} style={{ width, ['--gantt-head' as string]: `${head}px` } as CSSProperties}>
      <div className="gantt-head" aria-hidden="true">
        <div className="gantt-band-row">
          {header.top.map((b) => (
            <span key={b.col} style={{ left: b.col * dayW, width: b.span * dayW }}>
              <strong>{b.label}</strong>{b.sub && b.span * dayW > 80 ? ` ${b.sub}` : ''}
            </span>
          ))}
        </div>
        <div className="gantt-band-row is-small">
          {header.bottom.map((b) => (
            <span
              key={b.col}
              className={zoom === 'day' ? `${holidays.has(days[b.col]) ? 'is-holiday' : ''}${days[b.col] === today ? ' is-today' : ''}` : ''}
              style={{ left: b.col * dayW, width: b.span * dayW }}
            >
              {b.span * dayW >= 12 ? b.label : ''}
            </span>
          ))}
        </div>
        {todayX != null && (
          <div className="gantt-today-mark" style={{ left: todayX }}>
            <span className="gantt-today-flag">Today</span>
          </div>
        )}
      </div>

      <svg
        className={`gantt-body${chain ? ' is-tracing' : ''}${drag?.moved ? ' is-dragging' : ''}`}
        width={width}
        height={bodyH}
        viewBox={`0 0 ${width} ${bodyH}`}
        role="group"
        aria-label="Gantt chart"
        onPointerMove={onPointerMove}
        onPointerUp={(e) => endDrag(e, false)}
        onPointerCancel={(e) => endDrag(e, true)}
      >
        <defs>
          <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 8 4 0 8z" />
          </marker>
          <marker id="gantt-arrow-critical" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 8 4 0 8z" />
          </marker>
        </defs>

        {days.map((d, i) => holidays.has(d) && (
          <rect key={`h${d}`} className="gantt-holiday" x={i * dayW} y={0} width={dayW} height={bodyH}><title>{`${formatDate(d)}: holiday`}</title></rect>
        ))}
        {grid.map(({ col, strong }) => (
          <line key={`c${col}`} className={strong ? 'gantt-week-line' : 'gantt-day-line'} x1={col * dayW + 0.5} x2={col * dayW + 0.5} y1={0} y2={bodyH} />
        ))}
        {[...rows.entries()].filter(([, r]) => r.height > 0).map(([id, r]) => (
          <line key={`r${id}`} className="gantt-row-line" x1={0} x2={width} y1={r.top - head + r.height - 0.5} y2={r.top - head + r.height - 0.5} />
        ))}

        {bookingBands}

        {targetX != null && (
          <line className="gantt-target" x1={targetX} x2={targetX} y1={0} y2={bodyH}>
            <title>Target {formatDate(target!)}</title>
          </line>
        )}

        {show.baseline && tasks.map((t) => {
          const b = baseline.get(t.id);
          const g = shapes.get(t.id);
          if (!b || !g) return null;
          const { x0, x1 } = g.milestone
            ? { x0: colX(b.end, 'end') - 4, x1: colX(b.end, 'end') + 4 }
            : spanX(scale, b.start, b.end, dayW);
          return (
            <rect key={`bl${t.id}`} className="gantt-baseline" x={x0 + 1} y={g.mid + BAR_H / 2 + 2} width={Math.max(2, x1 - x0 - 2)} height={4}>
              <title>{`Baseline ${formatRange(b.start, b.end)}`}</title>
            </rect>
          );
        })}

        {show.float && tasks.map((t) => {
          const g = shapes.get(t.id);
          const s = shown.get(t.id);
          if (!g || !s || g.summary || s.critical || s.total_float <= 0) return null;
          const x = colX(s.late_end, 'end');
          if (x <= g.x1) return null;
          const y = g.mid + (g.milestone ? 0 : BAR_H / 2 - 1);
          return (
            <g key={`f${t.id}`} className={`gantt-float${chain && !chain.has(t.id) ? ' is-faded' : ''}`}>
              <line x1={g.x1} x2={x} y1={y} y2={y} />
              <line x1={x - 0.5} x2={x - 0.5} y1={y - 3} y2={y + 3} />
              <title>{`${s.total_float} working days of float: it can finish by ${formatDate(s.late_end)} without moving the finish`}</title>
            </g>
          );
        })}

        {/* Deadlines: an ink chevron hanging over the last day it may finish, and a
            bracket over any part of the bar past it. Never a hatch: that is a double-booking. */}
        {tasks.map((t) => {
          const g = shapes.get(t.id);
          const s = shown.get(t.id);
          if (!g || !s?.deadline) return null;
          const x = colX(snapToWorkingDay(s.deadline, holidays, -1), 'end');
          const top = g.mid - BAR_H / 2;
          const over = s.deadline_slack != null && s.deadline_slack < 0 && g.x1 > x;
          return (
            <g key={`dl${t.id}`} className={`gantt-deadline${over ? ' is-over' : ''}${chain && !chain.has(t.id) ? ' is-faded' : ''}`}>
              <line x1={x - 0.5} x2={x - 0.5} y1={top - 6} y2={g.mid + BAR_H / 2 + 1} />
              <path d={`M${x - 5} ${top - 9}h10l-5 6z`} />
              {over && <path className="gantt-overrun" d={`M${x} ${top - 1}v-3H${g.x1}v3`} />}
              <title>{`Deadline ${formatDate(s.deadline)}${t.deadline ? '' : ', from the summary above'}${over ? `: finishes ${-s.deadline_slack!} working day${s.deadline_slack === -1 ? '' : 's'} after it` : ''}`}</title>
            </g>
          );
        })}

        {deps.map(linkDrawn)}
        {tasks.map(barFor)}
        {tasks.map(labelFor)}

        {drag?.mode === 'link' && drag.moved && shapes.get(drag.id) && (
          <line className="gantt-rubber" x1={shapes.get(drag.id)!.x1 + 5} y1={shapes.get(drag.id)!.mid} x2={drag.px} y2={drag.py - head} />
        )}

        {todayX != null && <line className="gantt-today" x1={todayX + 1} x2={todayX + 1} y1={0} y2={bodyH} />}
      </svg>

      {strip && show.strip && <Strip strip={strip} live={live?.result ?? null} days={days} dayW={dayW} scale={scale} />}

      {readout && (
        <div className="gantt-readout" style={{ left: readout.x, top: readout.y }} role="status">
          {readout.lines.map((l) => <div key={l}>{l}</div>)}
          {readout.alarm.map((l) => <div key={l} className="is-alarm">{l}</div>)}
        </div>
      )}

      {linkEdit && (
        <LinkEditor
          dep={linkEdit.dep}
          x={linkEdit.x}
          y={linkEdit.y}
          from={byId.get(linkEdit.dep.predecessor_id)?.name ?? ''}
          to={byId.get(linkEdit.dep.successor_id)?.name ?? ''}
          summary={!!outline.get(linkEdit.dep.predecessor_id)?.summary || !!outline.get(linkEdit.dep.successor_id)?.summary}
          onClose={() => setLinkEdit(null)}
          onSave={async (next) => { setLinkEdit(null); await onLinkChange(linkEdit.dep, next); }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- occupancy strip

/**
 * How full each environment the plan uses is, day by day, across the whole team.
 * Neutral ink by level; red only where a double-booking is open, green where it
 * has been accepted. During a drag it shows the would-be plan.
 */
function Strip({ strip, live, days, dayW, scale }: {
  strip: StripData;
  live: GanttPreview | null;
  days: readonly ISODate[];
  dayW: number;
  scale: GanttScale;
}) {
  const bookings = live?.bookings ?? strip.bookings;
  const conflicts = live?.conflicts ?? strip.conflicts;
  const width = days.length * dayW;
  const height = STRIP_HEAD + strip.environments.length * STRIP_LANE;
  return (
    <svg className="gantt-strip" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img"
      aria-label="How full each environment is, day by day">
      <line className="gantt-week-line" x1={0} x2={width} y1={0.5} y2={0.5} />
      {strip.environments.map((env, lane) => {
        const y = STRIP_HEAD + lane * STRIP_LANE;
        const counts = occupancyByDay(bookings, env.id, days);
        const runs: { col: number; span: number; n: number }[] = [];
        counts.forEach((n, i) => {
          const last = runs[runs.length - 1];
          if (last && last.n === n && last.col + last.span === i) last.span++;
          else runs.push({ col: i, span: 1, n });
        });
        const cap = Math.max(1, env.capacity);
        return (
          <g key={env.id} style={{ ['--env-color' as string]: ENV_COLOR[env.kind] } as CSSProperties}>
            <line className="gantt-row-line" x1={0} x2={width} y1={y + STRIP_LANE - 0.5} y2={y + STRIP_LANE - 0.5} />
            {runs.filter((r) => r.n > 0).map((r) => (
              <rect key={r.col} className="gantt-occ" x={r.col * dayW} y={y + 6} width={r.span * dayW} height={STRIP_LANE - 12}
                style={{ opacity: Math.min(0.45, 0.14 + 0.22 * (r.n / cap)) }}>
                <title>{`${env.name}: ${r.n} of ${cap} booked, ${formatRange(days[r.col], days[r.col + r.span - 1])}`}</title>
              </rect>
            ))}
            {conflicts.filter((c) => c.environment_id === env.id).map((c) => {
              const { x0, x1 } = spanX(scale, c.start_date, c.end_date, dayW);
              return (
                <rect key={`${c.start_date}-${c.booking_ids.join()}`} className={c.resolved ? 'gantt-clash is-resolved' : 'gantt-clash'}
                  x={x0} y={y + 3} width={Math.max(2, x1 - x0)} height={STRIP_LANE - 6}>
                  <title>{`${c.resolved ? 'Accepted double-booking' : 'Double-booked'}: ${env.name}, ${c.projects.map((p) => p.name).join(' and ')}, ${formatRange(c.start_date, c.end_date)}`}</title>
                </rect>
              );
            })}
          </g>
        );
      })}
    </svg>
  );
}

// ---------------------------------------------------------------- link editing

/** "Merchant UAT starts 2 working days after Vault regression finishes." */
function linkSentence(to: string, from: string, d: Pick<TaskDependency, 'type' | 'lag'>): string {
  const n = Math.abs(d.lag);
  const when = d.lag === 0 ? 'after' : `${n} working day${n === 1 ? '' : 's'} ${d.lag > 0 ? 'after' : 'before'}`;
  const type = d.type ?? 'FS';
  const verb = type === 'FF' ? 'finishes' : 'starts';
  const theirs = type === 'SS' ? 'starts' : 'finishes';
  return `${to} ${verb} ${when} ${from} ${theirs}`;
}

function LinkEditor({ dep, x, y, from, to, summary, onClose, onSave }: {
  dep: TaskDependency; x: number; y: number; from: string; to: string; summary: boolean;
  onClose: () => void;
  onSave: (next: { type: LinkType; lag: number } | null) => Promise<void>;
}) {
  const [type, setType] = useState<LinkType>(dep.type ?? 'FS');
  const [lag, setLag] = useState(String(dep.lag));
  const lagN = Number(lag);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.querySelector('select')?.focus();
    const away = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) onClose(); };
    window.addEventListener('pointerdown', away, true);
    return () => window.removeEventListener('pointerdown', away, true);
  }, []);
  return (
    <div className="gantt-link-pop" ref={box} style={{ left: x, top: y + 8 }} role="dialog" aria-label="Edit link"
      onKeyDown={(e) => { if (e.key === 'Escape') onClose(); }}>
      <p>{linkSentence(to, from, { type, lag: Number.isInteger(lagN) ? lagN : 0 })}.</p>
      <div className="gantt-link-fields">
        <label>Type
          <select value={type} onChange={(e) => setType(e.target.value as LinkType)}>
            <option value="FS">Finish → start</option>
            <option value="SS" disabled={summary}>Start → start</option>
            <option value="FF" disabled={summary}>Finish → finish</option>
          </select>
        </label>
        <label>Lag, working days
          <input inputMode="numeric" value={lag} onChange={(e) => setLag(e.target.value)} aria-invalid={!Number.isInteger(lagN) || undefined} />
        </label>
      </div>
      <div className="gantt-link-actions">
        <button type="button" className="btn quiet" onClick={() => void onSave(null)}>Remove link</button>
        <span className="spacer" />
        <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
        <button type="button" className="btn" disabled={!Number.isInteger(lagN)} onClick={() => void onSave({ type, lag: lagN })}>Save</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- geometry

/** A summary: a thin ink bar with a bracket down at each end, as scheduling tools draw them. */
function summaryPath(g: Pick<Shape, 'x0' | 'x1' | 'mid'>): string {
  const top = g.mid - 4;
  const w = Math.max(10, g.x1 - g.x0);
  return `M${g.x0} ${top}h${w}v10l-5 -4h${-(w - 10)}l-5 4z`;
}

type LinkEnd = Pick<Shape, 'x0' | 'x1' | 'mid' | 'milestone'>;

/**
 * A link, drawn the usual way for its type. FS: out of the predecessor's end,
 * a short step right, then down (or up) onto the successor near its start.
 * SS: out of its start, round the left, into the successor's start. FF: out of
 * its end, round the right, into the successor's end.
 */
export function linkPath(p: LinkEnd, s: LinkEnd, type: LinkType = 'FS'): string {
  const down = s.mid >= p.mid;
  const dir = down ? 1 : -1;
  if (type === 'SS') {
    const vx = Math.min(p.x0, s.x0) - 8;
    return `M${p.x0} ${p.mid}H${vx}V${s.mid}H${s.x0 - 1}`;
  }
  if (type === 'FF') {
    const vx = Math.max(p.x1, s.x1) + 8;
    return `M${p.x1} ${p.mid}H${vx}V${s.mid}H${s.x1 + 1}`;
  }
  const x = p.milestone ? p.x0 + DIAMOND : p.x1;
  if (s.milestone) {
    const cx = s.x0 + DIAMOND;
    const vx = Math.max(x + 8, cx);
    const off = vx - cx;
    // Land on the diamond's edge from above, or, when the step overshoots it, come in from the side.
    if (off <= DIAMOND - 2) return `M${x} ${p.mid}H${vx}V${s.mid - dir * (DIAMOND - off + 1)}`;
    return `M${x} ${p.mid}H${vx}V${s.mid}H${cx + DIAMOND + 1}`;
  }
  const vx = Math.max(x + 8, s.x0 + 6);
  return `M${x} ${p.mid}H${vx}V${s.mid - dir * (BAR_H / 2 + 1)}`;
}
