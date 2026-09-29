import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { api, type PortfolioData } from '../api.ts';
import type { ISODate, TaskSchedule } from '../../shared/types.ts';
import { inOutlineOrder, outline } from '../../shared/wbs.ts';
import { formatDate, formatRange } from '../layout.ts';
import {
  dayColumn, DAY_WIDTH, ganttDays, ganttScale, gridLines, headerBands, minWeeksFor, spanX, ZOOM_LABEL, ZOOMS, type Zoom,
} from '../gantt.ts';
import { linkPath } from './Gantt.tsx';

/**
 * Every plan of the team on one chart: each project as a summary bar from its
 * first task to its last, its target and how late it runs, and its tasks
 * underneath when opened. Read-only; a project's name opens its plan.
 *
 * Links between projects are not modelled yet, so each project's arrows stay
 * inside it.
 */

const ROW = 30;
const HEAD = 48;
const BAR_H = 12;

type Row =
  | { kind: 'project'; id: number; name: string; start: ISODate | null; end: ISODate | null; target: ISODate | null; late: number; critical: boolean; count: number }
  | { kind: 'task'; projectId: number; id: number; name: string; depth: number; s: TaskSchedule; summary: boolean; milestone: boolean };

export function Portfolio({ teamId, currentId, holidays, today, onOpen }: {
  teamId: number;
  currentId: number;
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  onOpen: (projectId: number) => void;
}) {
  const [data, setData] = useState<PortfolioData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>('week');
  const [open, setOpen] = useState<Set<number>>(() => new Set([currentId]));
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    api.portfolio(teamId).then((d) => { if (live) { setData(d); setError(null); } })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'Could not load the portfolio'); });
    return () => { live = false; };
  }, [teamId]);

  const rows = useMemo<Row[]>(() => {
    if (!data) return [];
    const out: Row[] = [];
    for (const p of data.projects) {
      const sched = new Map(p.schedule.map((s) => [s.id, s]));
      const work = p.schedule.filter((s) => !s.summary);
      out.push({
        kind: 'project', id: p.project.id, name: p.project.name,
        start: work.length ? work.reduce((m, s) => (s.start < m ? s.start : m), work[0].start) : null,
        end: p.finish, target: p.project.target_date ?? null, late: p.late_by,
        critical: false, count: p.tasks.length,
      });
      if (!open.has(p.project.id)) continue;
      const o = new Map(outline(p.tasks).map((r) => [r.id, r]));
      for (const t of inOutlineOrder(p.tasks)) {
        const s = sched.get(t.id);
        if (!s) continue;
        const r = o.get(t.id)!;
        out.push({ kind: 'task', projectId: p.project.id, id: t.id, name: t.name, depth: r.depth, s, summary: r.summary, milestone: !r.summary && t.duration === 0 });
      }
    }
    return out;
  }, [data, open]);

  const scale = useMemo(() => ganttScale(
    (data?.projects ?? []).flatMap((p) => [p.project.target_date, ...p.schedule.flatMap((s) => [s.start, s.end])]).concat(today),
    minWeeksFor(zoom),
  ), [data, zoom, today]);
  const days = useMemo(() => (scale ? ganttDays(scale) : []), [scale]);
  const header = useMemo(() => headerBands(days, zoom), [days, zoom]);
  const grid = useMemo(() => gridLines(days, zoom), [days, zoom]);
  const dayW = DAY_WIDTH[zoom];

  const toToday = () => {
    if (!scale || !scroller.current) return;
    scroller.current.scrollTo({ left: Math.max(0, (dayColumn(scale, today, 'start') - 10) * dayW), behavior: 'smooth' });
  };
  useEffect(() => { if (scale && scroller.current && today > scale.start) scroller.current.scrollLeft = Math.max(0, (dayColumn(scale, today, 'start') - 10) * dayW); }, [scale?.start, dayW]);

  if (error) return <div className="error-bar" role="alert">{error}</div>;
  if (!data || !scale) return <div className="empty"><p>Loading the team’s plans…</p></div>;
  if (!data.projects.length) return <div className="empty"><h2>No projects yet</h2></div>;

  const width = days.length * dayW;
  const height = rows.length * ROW;
  const colX = (d: ISODate, edge: 'start' | 'end') => (dayColumn(scale, d, edge) + (edge === 'end' ? 1 : 0)) * dayW;
  const todayX = today >= scale.start && dayColumn(scale, today, 'start') < days.length ? dayColumn(scale, today, 'start') * dayW : null;
  const toggle = (id: number) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  // Where each task sits, for drawing its project's links.
  const at = new Map<number, { x0: number; x1: number; mid: number; milestone: boolean }>();
  rows.forEach((r, i) => {
    if (r.kind !== 'task') return;
    const mid = i * ROW + ROW / 2;
    if (r.milestone) {
      const cx = colX(r.s.end, 'end');
      at.set(r.id, { x0: cx - 6, x1: cx + 6, mid, milestone: true });
    } else at.set(r.id, { ...spanX(scale, r.s.start, r.s.end, dayW), mid, milestone: false });
  });

  return (
    <div className="portfolio">
      <div className="gantt-toolbar" role="toolbar" aria-label="Portfolio">
        <div className="segmented" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>{ZOOM_LABEL[z]}</button>)}
        </div>
        <button type="button" className="btn quiet" onClick={toToday}>Today</button>
        <button type="button" className="btn quiet" onClick={() => setOpen(new Set(data.projects.map((p) => p.project.id)))}>Open all</button>
        <button type="button" className="btn quiet" onClick={() => setOpen(new Set())}>Close all</button>
        <span className="toolbar-note">Each project runs from its first task to its last. Links between projects are not tracked yet.</span>
      </div>
      <div className="task-split portfolio-split" ref={scroller}>
        <div className="task-split-table portfolio-names">
          <div className="portfolio-names-head" style={{ height: HEAD }}>Project</div>
          {rows.map((r) => (r.kind === 'project' ? (
            <div key={`p${r.id}`} className={`portfolio-row is-project${r.id === currentId ? ' is-current' : ''}`} style={{ height: ROW }}>
              <button type="button" className="outline-toggle" aria-expanded={open.has(r.id)} disabled={!r.count}
                aria-label={`${open.has(r.id) ? 'Hide' : 'Show'} the tasks of ${r.name}`} onClick={() => toggle(r.id)}>
                <svg viewBox="0 0 10 10" aria-hidden="true"><path d={open.has(r.id) ? 'M1.5 3 5 7 8.5 3z' : 'M3 1.5 7 5 3 8.5z'} /></svg>
              </button>
              <button type="button" className="link-button portfolio-name" onClick={() => onOpen(r.id)} title="Open its plan">{r.name}</button>
              <span className="portfolio-fact">
                {!r.count ? 'no plan yet' : r.end ? formatDate(r.end) : ''}
                {r.late > 0 && <span className="late-tag">{r.late}d late</span>}
              </span>
            </div>
          ) : (
            <div key={`t${r.id}`} className={`portfolio-row${r.summary ? ' is-summary' : ''}`} style={{ height: ROW, ['--depth' as string]: r.depth } as CSSProperties}>
              <span className="portfolio-task">{r.name}</span>
              <span className="portfolio-fact">{r.s.critical ? 'critical' : ''}</span>
            </div>
          )))}
        </div>
        <div className="gantt" style={{ width, ['--gantt-head' as string]: `${HEAD}px` } as CSSProperties} aria-hidden="true">
          <div className="gantt-head">
            <div className="gantt-band-row">
              {header.top.map((b) => (
                <span key={b.col} style={{ left: b.col * dayW, width: b.span * dayW }}><strong>{b.label}</strong>{b.sub && b.span * dayW > 80 ? ` ${b.sub}` : ''}</span>
              ))}
            </div>
            <div className="gantt-band-row is-small">
              {header.bottom.map((b) => <span key={b.col} style={{ left: b.col * dayW, width: b.span * dayW }}>{b.span * dayW >= 12 ? b.label : ''}</span>)}
            </div>
            {todayX != null && <div className="gantt-today-mark" style={{ left: todayX }}><span className="gantt-today-flag">Today</span></div>}
          </div>
          <svg className="gantt-body" width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
            <defs>
              <marker id="pf-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M0 0 8 4 0 8z" />
              </marker>
            </defs>
            {days.map((d, i) => holidays.has(d) && <rect key={`h${d}`} className="gantt-holiday" x={i * dayW} y={0} width={dayW} height={height} />)}
            {grid.map(({ col, strong }) => (
              <line key={col} className={strong ? 'gantt-week-line' : 'gantt-day-line'} x1={col * dayW + 0.5} x2={col * dayW + 0.5} y1={0} y2={height} />
            ))}
            {rows.map((r, i) => (
              <line key={`r${i}`} className={r.kind === 'project' && i > 0 ? 'gantt-week-line' : 'gantt-row-line'} x1={0} x2={width} y1={i * ROW + 0.5} y2={i * ROW + 0.5} />
            ))}
            {data.projects.flatMap((p) => p.dependencies.map((d) => {
              const a = at.get(d.predecessor_id);
              const b = at.get(d.successor_id);
              if (!a || !b) return null;
              return <path key={`${d.predecessor_id}-${d.successor_id}`} className="gantt-link" d={linkPath(a, b, d.type ?? 'FS')} markerEnd="url(#pf-arrow)" />;
            }))}
            {rows.map((r, i) => {
              const mid = i * ROW + ROW / 2;
              if (r.kind === 'project') {
                if (!r.start || !r.end) return null;
                const { x0, x1 } = spanX(scale, r.start, r.end, dayW);
                const tx = r.target ? colX(r.target, 'end') : null;
                return (
                  <g key={`p${r.id}`} className="pf-project">
                    <path className="gantt-summary" d={`M${x0} ${mid - 5}h${Math.max(10, x1 - x0)}v12l-5 -5h${-(Math.max(10, x1 - x0) - 10)}l-5 5z`}>
                      <title>{`${r.name}: ${formatRange(r.start, r.end)}${r.late ? `, ${r.late} working days late` : ''}`}</title>
                    </path>
                    {tx != null && <line className="gantt-target" x1={tx} x2={tx} y1={mid - 10} y2={mid + 10}><title>{`Target ${formatDate(r.target!)}`}</title></line>}
                  </g>
                );
              }
              const { x0, x1 } = at.get(r.id)!;
              const cls = `gantt-task pf-task${r.s.critical ? ' is-critical' : ''}${r.summary ? ' is-summary' : ''}`;
              return (
                <g key={`t${r.id}`} className={cls}>
                  <title>{`${r.name}: ${formatRange(r.s.start, r.s.end)}`}</title>
                  {r.summary ? <path className="gantt-summary" d={`M${x0} ${mid - 3}h${Math.max(10, x1 - x0)}v8l-4 -3h${-(Math.max(10, x1 - x0) - 8)}l-4 3z`} />
                    : r.milestone ? <path className="gantt-shape" d={`M${x0 + 6} ${mid - 6}l6 6l-6 6l-6 -6z`} />
                      : <rect className="gantt-shape" x={x0 + 1} y={mid - BAR_H / 2} width={Math.max(2, x1 - x0 - 2)} height={BAR_H} rx={2} />}
                </g>
              );
            })}
            {todayX != null && <line className="gantt-today" x1={todayX + 1} x2={todayX + 1} y1={0} y2={height} />}
          </svg>
        </div>
      </div>
    </div>
  );
}
