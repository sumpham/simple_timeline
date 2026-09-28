import { useEffect, useMemo, useRef, type CSSProperties } from 'react';
import type { Environment, ISODate, Task, TaskDependency, TaskSchedule } from '../../shared/types.ts';
import { formatDate, formatRange } from '../layout.ts';
import { dayColumn, ganttDays, ganttScale, GANTT_DAY, GANTT_WEEK, spanX } from '../gantt.ts';
import { ENV_COLOR } from './Board.tsx';

/**
 * The task table's chart: one bar per row, beside the row it draws. The table
 * is the source of truth and the way in for the keyboard; the chart only shows
 * the shape of the plan, so it is hidden from assistive tech and a click on a
 * bar opens the same editor as the row number.
 *
 * Rows are not laid out here. The table measures its own rows (`RowBox`) and
 * the chart draws at those heights, so a row that grows never drifts.
 */

export type RowBox = { top: number; height: number };

const BAR_H = 14;
const DIAMOND = 7;

const WEEKDAY_LETTER = ['M', 'T', 'W', 'T', 'F'];

export function Gantt({
  tasks, deps, schedule, environments, holidays, today, start, target, rows, head, height, onOpen,
}: {
  tasks: readonly Task[];
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
  onOpen: (id: number) => void;
}) {
  const scale = useMemo(() => ganttScale([
    start, target, ...[...schedule.values()].flatMap((s) => [s.start, s.end]),
  ]), [schedule, start, target]);
  const days = useMemo(() => (scale ? ganttDays(scale) : []), [scale]);
  const ref = useRef<HTMLDivElement>(null);

  // Open on this week: a plan that began months ago should not open on its first day.
  const scrolledFor = useRef<ISODate | null>(null);
  useEffect(() => {
    const scroller = ref.current?.parentElement;
    if (!scale || !scroller || scrolledFor.current === scale.start) return;
    scrolledFor.current = scale.start;
    if (today > scale.start) scroller.scrollLeft = Math.max(0, dayColumn(scale, today, 'start') * GANTT_DAY - GANTT_WEEK);
  }, [scale, today]);

  if (!scale) return <div className="gantt" aria-hidden="true" />;

  const width = days.length * GANTT_DAY;
  const bodyH = Math.max(0, height - head);
  const envColor = (id: number | null) => {
    const env = environments.find((e) => e.id === id);
    return env ? ENV_COLOR[env.kind] : null;
  };

  /** Each task's drawn shape, in body coordinates. */
  const shapes = new Map<number, { x0: number; x1: number; mid: number; milestone: boolean }>();
  for (const t of tasks) {
    const s = schedule.get(t.id);
    const r = rows.get(t.id);
    if (!s || !r) continue;
    const mid = r.top - head + r.height / 2;
    if (t.duration === 0) {
      // A milestone is the end of its day, where its predecessor finishes.
      const cx = (dayColumn(scale, s.end, 'end') + 1) * GANTT_DAY;
      shapes.set(t.id, { x0: cx - DIAMOND, x1: cx + DIAMOND, mid, milestone: true });
    } else {
      shapes.set(t.id, { ...spanX(scale, s.start, s.end), mid, milestone: false });
    }
  }

  const todayCol = today >= scale.start ? dayColumn(scale, today, 'start') : -1;
  const targetX = target ? (dayColumn(scale, target, 'end') + 1) * GANTT_DAY : null;

  return (
    <div className="gantt" ref={ref} aria-hidden="true" style={{ width, ['--gantt-head' as string]: `${head}px` } as CSSProperties}>
      <div className="gantt-head">
        <div className="gantt-weeks">
          {Array.from({ length: scale.weeks }, (_, w) => (
            <span key={w} style={{ width: GANTT_WEEK }}>
              <strong>Week {w + 1}</strong> {formatDate(days[w * 5])}
            </span>
          ))}
        </div>
        <div className="gantt-days">
          {days.map((d, i) => (
            <span
              key={d}
              className={`${holidays.has(d) ? 'is-holiday' : ''}${d === today ? ' is-today' : ''}`}
              title={holidays.has(d) ? `${formatDate(d)}: holiday` : undefined}
            >
              {WEEKDAY_LETTER[i % 5]}
            </span>
          ))}
        </div>
      </div>

      <svg className="gantt-body" width={width} height={bodyH} viewBox={`0 0 ${width} ${bodyH}`}>
        <defs>
          <marker id="gantt-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 8 4 0 8z" />
          </marker>
          <marker id="gantt-arrow-critical" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M0 0 8 4 0 8z" />
          </marker>
        </defs>

        {days.map((d, i) => holidays.has(d) && (
          <rect key={`h${d}`} className="gantt-holiday" x={i * GANTT_DAY} y={0} width={GANTT_DAY} height={bodyH} />
        ))}
        {days.map((_, i) => (
          <line key={`c${i}`} className={i % 5 === 0 ? 'gantt-week-line' : 'gantt-day-line'} x1={i * GANTT_DAY + 0.5} x2={i * GANTT_DAY + 0.5} y1={0} y2={bodyH} />
        ))}
        {[...rows.values()].map((r, i) => (
          <line key={`r${i}`} className="gantt-row-line" x1={0} x2={width} y1={r.top - head + r.height - 0.5} y2={r.top - head + r.height - 0.5} />
        ))}

        {targetX != null && (
          <line className="gantt-target" x1={targetX} x2={targetX} y1={0} y2={bodyH}>
            <title>Target {formatDate(target!)}</title>
          </line>
        )}

        {deps.map((d) => {
          const p = shapes.get(d.predecessor_id);
          const s = shapes.get(d.successor_id);
          if (!p || !s) return null;
          const critical = !!schedule.get(d.predecessor_id)?.critical && !!schedule.get(d.successor_id)?.critical;
          return (
            <path
              key={`${d.predecessor_id}-${d.successor_id}`}
              className={`gantt-link${critical ? ' is-critical' : ''}`}
              d={linkPath(p, s)}
              markerEnd={`url(#gantt-arrow${critical ? '-critical' : ''})`}
            />
          );
        })}

        {tasks.map((t) => {
          const g = shapes.get(t.id);
          const s = schedule.get(t.id);
          if (!g || !s) return null;
          const color = envColor(t.environment_id);
          const cls = `gantt-task${s.critical ? ' is-critical' : ''}${t.status === 'done' ? ' is-done' : ''}${color ? '' : ' is-unbooked'}`;
          const label = `${t.name}: ${g.milestone ? formatDate(s.end) : formatRange(s.start, s.end)}${s.critical ? ', critical' : `, ${s.total_float}d float`}`;
          return (
            <g
              key={t.id}
              className={cls}
              style={{ ['--env-color' as string]: color ?? 'transparent' } as CSSProperties}
              onClick={() => onOpen(t.id)}
            >
              <title>{label}</title>
              {g.milestone ? (
                <path
                  d={`M${g.x0 + DIAMOND} ${g.mid - DIAMOND} l${DIAMOND} ${DIAMOND} l${-DIAMOND} ${DIAMOND} l${-DIAMOND} ${-DIAMOND}z`}
                />
              ) : (
                <rect x={g.x0 + 1} y={g.mid - BAR_H / 2} width={Math.max(2, g.x1 - g.x0 - 2)} height={BAR_H} rx={2} />
              )}
            </g>
          );
        })}

        {todayCol >= 0 && todayCol < days.length && (
          <line className="gantt-today" x1={todayCol * GANTT_DAY + 0.5} x2={todayCol * GANTT_DAY + 0.5} y1={0} y2={bodyH} />
        )}
      </svg>
    </div>
  );
}

type Shape = { x0: number; x1: number; mid: number; milestone: boolean };

/**
 * Finish-to-start, drawn the usual way: out of the predecessor's end, a short
 * step right, then down (or up) to land on the successor near its start.
 */
export function linkPath(p: Shape, s: Shape): string {
  const x = p.milestone ? p.x0 + DIAMOND : p.x1;
  const down = s.mid >= p.mid;
  const dir = down ? 1 : -1;
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
