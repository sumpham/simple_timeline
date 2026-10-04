import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { api } from '../api.ts';
import type { Environment, ISODate, Resource } from '../../shared/types.ts';
import type { PlanOp } from '../../shared/assistant/moves.ts';
import type { Suggestion } from '../../shared/assistant/optimise.ts';
import type { PlanReview, ReviewSide, ReviewTask, TaskChange } from '../../shared/assistant/review.ts';
import { loadByDay } from '../../shared/workload.ts';
import { snapToWorkingDay } from '../../shared/dates.ts';
import { formatMoney } from '../../shared/earnedValue.ts';
import { formatDate, formatRange } from '../layout.ts';
import {
  dayColumn, DAY_WIDTH, ganttDays, ganttScale, gridLines, headerBands, minWeeksFor, spanX, ZOOM_LABEL, ZOOMS, type GanttScale, type Zoom,
} from '../gantt.ts';
import { ENV_COLOR } from './Board.tsx';
import { PROFILE_WORD } from './Assistant.tsx';

/**
 * The review page (reqs/pm_features.md §8): a suggestion's to-be plan beside
 * the plan as it is, looked at from every side before Apply.
 *
 * Everything shown comes from `POST …/assistant/review`, which builds both
 * plans with the search's and the save's own functions; this file draws what
 * it returns and works out no span, float, clash or overlap itself. Apply is
 * the drawer's Apply: the same route, the same replan, the same Undo.
 */

type View = 'timeline' | 'environments' | 'people' | 'budget';
type Layout = 'overlay' | 'separate';

const VIEW_LABEL: Record<View, string> = { timeline: 'Timeline', environments: 'Environments', people: 'People', budget: 'Budget' };
const VIEW_KEY = 'review.view';
const ROW = 30;
const HEAD = 48;
const BAR_H = 14;
/** More rows than this and the timeline opens on what changed. */
const CHANGED_ONLY_FROM = 15;

function readView(): View {
  try {
    const v = localStorage.getItem(VIEW_KEY);
    return v === 'environments' || v === 'people' || v === 'budget' ? v : 'timeline';
  } catch { return 'timeline'; }
}

export function ReviewPage({
  projectId, suggestion, environments, holidays, today, people, onBack, onApply, onFindAgain,
}: {
  projectId: number;
  suggestion: Suggestion;
  environments: readonly Environment[];
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  people: ReadonlyMap<number, Resource>;
  onBack: () => void;
  /** Resolves to null once applied, or to why it was not. */
  onApply: (ops: PlanOp[], version: string, title: string) => Promise<string | null>;
  onFindAgain: () => void;
}) {
  const [ticked, setTicked] = useState<boolean[]>(() => suggestion.moves.map(() => true));
  const [review, setReview] = useState<PlanReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);
  const [applying, setApplying] = useState(false);
  const [view, setView] = useState<View>(readView);
  const [changedOnly, setChangedOnly] = useState<boolean | null>(null);
  const [layout, setLayout] = useState<Layout>('overlay');
  const [zoom, setZoom] = useState<Zoom>('day');
  const [focus, setFocus] = useState<number | null>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const chosen = suggestion.moves.filter((_, i) => ticked[i]);
  const all = chosen.length === suggestion.moves.length;
  const ops = useMemo(
    () => (all ? suggestion.ops : chosen.flatMap((m) => m.ops)),
    [suggestion, ticked.join(',')],
  );

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* a remembered view is a convenience */ }
  }, [view]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'text')) return;
      onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onBack]);

  // Work the review out again whenever the ticked moves change; debounced, so ticking three boxes asks once.
  useEffect(() => {
    if (!ops.length) { setReview(null); setLoading(false); setError(null); return; }
    let live = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api.reviewOps(projectId, ops, suggestion.version)
        .then((r) => { if (live) { setReview(r); setError(null); } })
        .catch((err: unknown) => {
          if (!live) return;
          const message = err instanceof Error ? err.message : 'Could not work out this plan';
          if (/changed since/.test(message)) setStale(true); else setError(message);
        })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [projectId, suggestion.version, ops]);

  const apply = async () => {
    setApplying(true);
    const why = await onApply(ops, suggestion.version, all ? suggestion.title : chosen.map((m) => m.title).join('; '));
    setApplying(false);
    if (why && /changed since/.test(why)) setStale(true);
    else if (why) setError(why);
  };

  const envById = useMemo(() => new Map(environments.map((e) => [e.id, e])), [environments]);
  const title = suggestion.profile === 'tidy' ? suggestion.title : suggestion.title.replace(/^[A-Z][a-z]+: /, '');
  const multi = suggestion.moves.length > 1;
  const rowCount = review ? review.after.tasks.length : 0;
  const onlyChanged = changedOnly ?? rowCount > CHANGED_ONLY_FROM;
  const subsetWorse = !all && review && review.diff.clashes_opened.length > 0;
  /** Budget only when something is costed; a remembered Budget view falls back to the timeline. */
  const shown: View = view === 'budget' && review && !review.diff.cost ? 'timeline' : view;

  return (
    <section className="review" aria-labelledby="review-title" aria-busy={loading}>
      <header className="review-head">
        <button type="button" className="btn quiet plan-back" onClick={onBack}>
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
          Back to suggestions
        </button>
        <h2 id="review-title" ref={titleRef} tabIndex={-1}>Review: {title}</h2>
        <span className="review-sub">
          {PROFILE_WORD[suggestion.profile]}, {suggestion.moves.length} move{suggestion.moves.length === 1 ? '' : 's'}
        </span>
      </header>

      <div className="review-verdict" aria-live="polite">
        {!ops.length ? (
          <p className="review-same">Tick at least one move to see the plan it makes.</p>
        ) : error ? (
          <p className="review-error" role="alert">{error}</p>
        ) : !review ? (
          <p className="review-same">Working out the plan…</p>
        ) : (
          <>
            {subsetWorse && (
              <p className="review-line is-worse">
                Without the unticked move{suggestion.moves.length - chosen.length === 1 ? '' : 's'}, this opens a double-booking the full suggestion avoids.
              </p>
            )}
            {review.verdict.worse.map((l) => <p key={l} className="review-line is-worse"><span className="review-word">Worse</span>{l}</p>)}
            {review.verdict.better.map((l) => <p key={l} className="review-line"><span className="review-word">Better</span>{l}</p>)}
            <p className="review-same">{review.verdict.same}</p>
          </>
        )}
      </div>

      <div className="review-body">
        <aside className="review-rail" aria-label="Moves and changes">
          <section>
            <h3>Moves</h3>
            <ol className="review-moves">
              {suggestion.moves.map((m, i) => (
                <li key={i}>
                  {multi ? (
                    <label className="review-move">
                      <input
                        type="checkbox"
                        checked={ticked[i]}
                        onChange={(e) => setTicked((t) => t.map((x, j) => (j === i ? e.target.checked : x)))}
                      />
                      <span className="review-move-title">{m.title}</span>
                    </label>
                  ) : <span className="review-move-title">{m.title}</span>}
                  <p className="review-move-why">{m.reason}</p>
                  {m.tradeoff && <p className="review-move-why"><strong>Trade-off.</strong> {m.tradeoff}</p>}
                </li>
              ))}
            </ol>
          </section>
          {review && (
            <section>
              <h3>Changes ({review.diff.tasks.length + review.diff.clashes_opened.length + review.diff.clashes_cleared.length})</h3>
              {review.diff.tasks.length === 0 && !review.diff.clashes_cleared.length && !review.diff.clashes_opened.length
                ? <p className="review-move-why">No task moves.</p>
                : (
                  <ul className="review-changes">
                    {review.diff.tasks.map((c) => (
                      <li key={c.id}>
                        <button type="button" aria-pressed={focus === c.id}
                          onClick={() => { setView('timeline'); setFocus(focus === c.id ? null : c.id); }}>
                          <span className="review-change-who">{c.label}</span>
                          <span className="review-change-what">{changeWords(c, envById).join('; ')}</span>
                        </button>
                      </li>
                    ))}
                    {review.diff.clashes_opened.map((c) => (
                      <li key={`o${c.env_name}${c.start_date}`}>
                        <button type="button" onClick={() => setView('environments')}>
                          <span className="review-change-who">{c.env_name}</span>
                          <span className="review-change-what is-worse">Double-booked {formatRange(c.start_date, c.end_date)}</span>
                        </button>
                      </li>
                    ))}
                    {review.diff.clashes_cleared.map((c) => (
                      <li key={`c${c.env_name}${c.start_date}`}>
                        <button type="button" onClick={() => setView('environments')}>
                          <span className="review-change-who">{c.env_name}</span>
                          <span className="review-change-what">Double-booking cleared, {formatRange(c.start_date, c.end_date)}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
            </section>
          )}
        </aside>

        <div className="review-view">
          <div className="review-tools" role="toolbar" aria-label="Review view">
            <div className="segmented" role="group" aria-label="Look at">
              {(Object.keys(VIEW_LABEL) as View[]).filter((v) => v !== 'budget' || review?.diff.cost).map((v) => (
                <button key={v} type="button" aria-pressed={shown === v} onClick={() => setView(v)}>{VIEW_LABEL[v]}</button>
              ))}
            </div>
            <div className="segmented" role="group" aria-label="Zoom">
              {ZOOMS.map((z) => <button key={z} type="button" aria-pressed={zoom === z} onClick={() => setZoom(z)}>{ZOOM_LABEL[z]}</button>)}
            </div>
            {shown === 'timeline' && (
              <>
                <label className="check">
                  <input type="checkbox" checked={onlyChanged} onChange={(e) => setChangedOnly(e.target.checked)} />
                  Changed only
                </label>
                <div className="segmented" role="group" aria-label="Show the current plan">
                  <button type="button" aria-pressed={layout === 'overlay'} onClick={() => setLayout('overlay')}>Outlined</button>
                  <button type="button" aria-pressed={layout === 'separate'} onClick={() => setLayout('separate')}>Separate</button>
                </div>
              </>
            )}
          </div>
          <div className="review-scroll">
          {review && (
            shown === 'timeline' ? (
              <ReviewTimeline review={review} envById={envById} holidays={holidays} today={today} zoom={zoom}
                layout={layout} changedOnly={onlyChanged} focus={focus} onFocus={setFocus} />
            ) : shown === 'budget' && review.diff.cost ? (
              <ReviewBudget cost={review.diff.cost} />
            ) : shown === 'environments' ? (
              <ReviewEnvironments review={review} envById={envById} projectId={projectId} holidays={holidays} today={today} zoom={zoom} />
            ) : (
              <ReviewPeople review={review} people={people} holidays={holidays} today={today} zoom={zoom} />
            )
          )}
          </div>
        </div>
      </div>

      <footer className="review-bar">
        {stale ? (
          <span className="review-bar-note is-stale" role="alert">The plan has changed since this was worked out.</span>
        ) : (
          <span className="review-bar-note">Worked out on the plan as it stands now{review ? `, status date ${formatDate(review.status_date)}` : ''}. Nothing is saved yet.</span>
        )}
        <div className="review-bar-actions">
          <button type="button" className="btn quiet" onClick={onBack}>Back</button>
          {stale ? (
            <button type="button" className="btn" onClick={onFindAgain}>Find again</button>
          ) : (
            <button type="button" className="btn" disabled={applying || loading || !review || !!error || !ops.length} onClick={() => void apply()}>
              {applying ? 'Applying…' : multi ? `Apply ${chosen.length} move${chosen.length === 1 ? '' : 's'}` : 'Apply'}
            </button>
          )}
        </div>
      </footer>
    </section>
  );
}

/** A task change in a few words, for the rail and the delta tags. */
function changeWords(c: TaskChange, envById: ReadonlyMap<number, Environment>): string[] {
  if (c.kind === 'created') return ['New task'];
  if (c.kind === 'removed') return ['Removed'];
  const env = (id: number | null) => (id == null ? 'no environment' : envById.get(id)?.name ?? 'an environment');
  const shift = (n: number) => `${Math.abs(n)} working day${Math.abs(n) === 1 ? '' : 's'} ${n > 0 ? 'later' : 'sooner'}`;
  const out: string[] = [];
  if (c.start && c.start === c.finish) out.push(`Moves ${shift(c.start)}`);
  else {
    if (c.start) out.push(`Starts ${shift(c.start)}`);
    if (c.finish) out.push(`Finishes ${shift(c.finish)}`);
  }
  if (c.duration) out.push(`${c.duration.before} → ${c.duration.after} working days`);
  if (c.environment) out.push(`${env(c.environment.before)} → ${env(c.environment.after)}`);
  if (c.critical === 'gained') out.push('Becomes critical');
  if (c.critical === 'lost') out.push('No longer critical');
  if (!c.critical && c.float && !c.start && !c.finish) out.push(`Float ${c.float.before} → ${c.float.after} days`);
  if (c.links) out.push('Links change');
  if (c.deadline?.change === 'missed') out.push(`Misses its deadline of ${formatDate(c.deadline.date)} by ${c.deadline.days}d`);
  if (c.deadline?.change === 'met') out.push(`Now meets its deadline of ${formatDate(c.deadline.date)}`);
  if (c.not_before && !c.start) out.push(c.not_before.after ? `Waits until ${formatDate(c.not_before.after)}` : 'No start date set');
  return out.length ? out : ['Changes'];
}

/** The short tag after a bar: how far it moved, or what else changed. */
function deltaTag(c: TaskChange | undefined, envById: ReadonlyMap<number, Environment>): string | null {
  if (!c) return null;
  if (c.kind === 'created') return 'new';
  if (c.kind === 'removed') return 'removed';
  const n = c.finish || c.start;
  const parts: string[] = [];
  if (n) parts.push(`${n > 0 ? '+' : '−'}${Math.abs(n)}d`);
  if (c.environment) parts.push(`${envById.get(c.environment.before ?? -1)?.name ?? 'none'} → ${envById.get(c.environment.after ?? -1)?.name ?? 'none'}`);
  if (c.critical === 'gained') parts.push('now critical');
  if (c.critical === 'lost') parts.push('off critical path');
  if (c.deadline?.change === 'missed') parts.push(`${c.deadline.days}d past deadline`);
  if (c.deadline?.change === 'met') parts.push('meets deadline');
  if (!parts.length && c.links) parts.push('links');
  return parts.join(', ') || null;
}

// ---------------------------------------------------------------- shared chart pieces

function useScale(dates: readonly (ISODate | null | undefined)[], zoom: Zoom, today: ISODate) {
  const key = dates.join(',');
  const scale = useMemo(() => ganttScale([...dates, today], minWeeksFor(zoom, 1000)), [key, zoom, today]);
  const days = useMemo(() => (scale ? ganttDays(scale) : []), [scale]);
  return { scale, days, dayW: DAY_WIDTH[zoom] };
}

function ChartHead({ days, zoom, dayW, scale, today }: { days: readonly ISODate[]; zoom: Zoom; dayW: number; scale: GanttScale; today: ISODate }) {
  const header = headerBands(days, zoom);
  const todayX = today >= scale.start && dayColumn(scale, today, 'start') < days.length ? dayColumn(scale, today, 'start') * dayW : null;
  return (
    <div className="gantt-head" style={{ width: days.length * dayW }}>
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
  );
}

function Grid({ days, zoom, dayW, height, holidays }: { days: readonly ISODate[]; zoom: Zoom; dayW: number; height: number; holidays: ReadonlySet<ISODate> }) {
  return (
    <>
      {days.map((d, i) => holidays.has(d) && <rect key={`h${d}`} className="gantt-holiday" x={i * dayW} y={0} width={dayW} height={height} />)}
      {gridLines(days, zoom).map(({ col, strong }) => (
        <line key={col} className={strong ? 'gantt-week-line' : 'gantt-day-line'} x1={col * dayW + 0.5} x2={col * dayW + 0.5} y1={0} y2={height} />
      ))}
    </>
  );
}

/** A two-column chart: names on the left, held in place while the time grid scrolls. */
function Split({ names, chart, width }: { names: ReactNode; chart: ReactNode; width: number }) {
  return (
    <div className="review-split">
      <div className="review-names">{names}</div>
      <div className="review-chart" style={{ width, ['--gantt-head' as string]: `${HEAD}px` } as CSSProperties}>{chart}</div>
    </div>
  );
}

// ---------------------------------------------------------------- timeline

type TimelineRow = { id: number; depth: number; was: ReviewTask | undefined; now: ReviewTask | undefined; change: TaskChange | undefined };

function ReviewTimeline({ review, envById, holidays, today, zoom, layout, changedOnly, focus, onFocus }: {
  review: PlanReview;
  envById: ReadonlyMap<number, Environment>;
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  zoom: Zoom;
  layout: Layout;
  changedOnly: boolean;
  focus: number | null;
  onFocus: (id: number | null) => void;
}) {
  const { before, after, diff } = review;
  const rows = useMemo(() => {
    const was = new Map(before.tasks.map((t) => [t.id, t]));
    const changes = new Map(diff.tasks.map((c) => [c.id, c]));
    const parent = new Map([...before.tasks, ...after.tasks].map((t) => [t.id, t.parent_id]));
    const depth = (id: number) => {
      let d = 0;
      for (let p = parent.get(id), guard = 0; p != null && guard < 16; p = parent.get(p), guard++) d++;
      return d;
    };
    const out: TimelineRow[] = after.tasks.map((t) => ({ id: t.id, depth: depth(t.id), was: was.get(t.id), now: t, change: changes.get(t.id) }));
    for (const t of before.tasks) if (!after.tasks.some((x) => x.id === t.id)) out.push({ id: t.id, depth: depth(t.id), was: t, now: undefined, change: changes.get(t.id) });
    return changedOnly ? out.filter((r) => r.change) : out;
  }, [review, changedOnly]);

  const dates = [...before.tasks, ...after.tasks].flatMap((t) => [t.start, t.end, t.deadline]);
  const { scale, days, dayW } = useScale(dates, zoom, today);
  const focusRef = useRef<HTMLDivElement>(null);
  useEffect(() => { focusRef.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [focus]);

  if (!scale) return null;
  if (!rows.length) return <div className="empty"><p>No task changes. Untick “Changed only” to see the whole plan.</p></div>;
  const width = days.length * dayW;

  const shape = (t: ReviewTask, mid: number, cls: string, key: string) => {
    if (t.milestone) {
      const cx = (dayColumn(scale, t.end, 'end') + 1) * dayW;
      return <path key={key} className={`gantt-shape ${cls}`} d={`M${cx} ${mid - 6}l6 6l-6 6l-6 -6z`} />;
    }
    const { x0, x1 } = spanX(scale, t.start, t.end, dayW);
    if (t.summary) return <path key={key} className={`gantt-summary ${cls}`} d={`M${x0} ${mid - 3}h${Math.max(10, x1 - x0)}v8l-4 -3h${-(Math.max(10, x1 - x0) - 8)}l-4 3z`} />;
    return <rect key={key} className={`gantt-shape ${cls}`} x={x0 + 1} y={mid - BAR_H / 2} width={Math.max(2, x1 - x0 - 2)} height={BAR_H} rx={2} />;
  };
  const endX = (t: ReviewTask) => (t.milestone ? (dayColumn(scale, t.end, 'end') + 1) * dayW + 8 : spanX(scale, t.start, t.end, dayW).x1 + 6);
  const envStyle = (t: ReviewTask) => {
    const env = t.environment_id != null ? envById.get(t.environment_id) : undefined;
    return { ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'var(--muted)' } as CSSProperties;
  };

  const block = (side: 'both' | 'was' | 'now', caption?: string) => {
    const height = rows.length * ROW;
    return (
      <div className="review-block" key={side}>
        {caption && <h4 className="review-block-title">{caption}</h4>}
        <Split
          width={width}
          names={(
            <>
              <div className="review-names-head" style={{ height: HEAD }}><span>ID</span><span>Task</span><span>Finish</span></div>
              {rows.map((r) => {
                const t = side === 'was' ? r.was : r.now ?? r.was;
                return (
                  <div key={r.id} ref={focus === r.id ? focusRef : undefined}
                    className={`review-row${r.change ? ' is-changed' : ''}${focus === r.id ? ' is-focus' : ''}${t?.summary ? ' is-summary' : ''}`}
                    style={{ height: ROW, ['--depth' as string]: r.depth } as CSSProperties}
                    onClick={() => r.change && onFocus(focus === r.id ? null : r.id)}>
                    <span className="review-code">{t?.code ?? ''}</span>
                    <span className="review-task" title={t?.name}>{t ? t.name : ''}</span>
                    <span className="review-finish">{t && (side !== 'was' || r.was) ? formatDate(t.end) : '—'}</span>
                  </div>
                );
              })}
            </>
          )}
          chart={(
            <>
              <ChartHead days={days} zoom={zoom} dayW={dayW} scale={scale} today={today} />
              <svg className="gantt-body" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
                <Grid days={days} zoom={zoom} dayW={dayW} height={height} holidays={holidays} />
                {rows.map((r, i) => (
                  <g key={r.id}>
                    <line className="gantt-row-line" x1={0} x2={width} y1={(i + 1) * ROW - 0.5} y2={(i + 1) * ROW - 0.5} />
                    {focus === r.id && <rect className="review-focus" x={0} y={i * ROW} width={width} height={ROW} />}
                  </g>
                ))}
                {rows.map((r, i) => {
                  const mid = i * ROW + ROW / 2;
                  const t = side === 'was' ? r.was : r.now;
                  const moved = r.was && r.now && (r.was.start !== r.now.start || r.was.end !== r.now.end);
                  const tag = side === 'both' ? deltaTag(r.change, envById) : null;
                  return (
                    <g key={r.id}>
                      {side === 'both' && r.was && (moved || !r.now) && shape(r.was, mid, 'review-was', 'was')}
                      {t && (
                        <g className={`gantt-task review-task-g${t.environment_id == null && !t.summary ? ' is-unbooked' : ''}${t.critical && !t.summary ? ' is-critical' : ''}${t.summary ? ' is-summary' : ''}`} style={envStyle(t)}>
                          <title>{`${t.name}: ${formatRange(t.start, t.end)}`}</title>
                          {shape(t, mid, '', 'now')}
                        </g>
                      )}
                      {t?.deadline && (() => {
                        const x = (dayColumn(scale, snapToWorkingDay(t.deadline, holidays, -1), 'end') + 1) * dayW;
                        const top = mid - BAR_H / 2;
                        return (
                          <g className={`gantt-deadline${t.deadline_slack != null && t.deadline_slack < 0 ? ' is-over' : ''}`}>
                            <line x1={x - 0.5} x2={x - 0.5} y1={top - 6} y2={mid + BAR_H / 2 + 1} />
                            <path d={`M${x - 5} ${top - 7}h10l-5 6z`} />
                            <title>{`Deadline ${formatDate(t.deadline)}`}</title>
                          </g>
                        );
                      })()}
                      {t && tag && <text className="gantt-label review-delta" x={Math.max(endX(t), r.was && moved ? endX(r.was) : 0)} y={mid + 4}>{tag}</text>}
                    </g>
                  );
                })}
              </svg>
            </>
          )}
        />
      </div>
    );
  };

  return (
    <div className="review-timeline">
      {layout === 'overlay' ? block('both') : (
        <>
          {block('was', 'Now')}
          {block('now', 'After')}
        </>
      )}
      {layout === 'overlay' && (
        <p className="review-legend">Solid bars are the plan after this change. A dashed outline is where a task is now.</p>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- environments

/** Pack bookings into sub-lanes, first fit by start date. */
function packLanes<T extends { start_date: ISODate; end_date: ISODate }>(items: readonly T[]): T[][] {
  const lanes: T[][] = [];
  for (const it of [...items].sort((a, b) => a.start_date.localeCompare(b.start_date))) {
    const lane = lanes.find((l) => l[l.length - 1].end_date < it.start_date);
    if (lane) lane.push(it); else lanes.push([it]);
  }
  return lanes;
}

function ReviewEnvironments({ review, envById, projectId, holidays, today, zoom }: {
  review: PlanReview;
  envById: ReadonlyMap<number, Environment>;
  projectId: number;
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  zoom: Zoom;
}) {
  const envs = review.diff.environment_ids;
  const dates = [...review.before.bookings, ...review.after.bookings].flatMap((b) => [b.start_date, b.end_date]);
  const { scale, days, dayW } = useScale(dates, zoom, today);
  if (!envs.length) return <div className="empty"><p>No change to environments. No booking moves and no double-booking comes or goes.</p></div>;
  if (!scale) return null;
  const width = days.length * dayW;
  const LANE = 22;

  const lanes = envs.flatMap((id) => (['before', 'after'] as const).map((side) => {
    const s: ReviewSide = review[side];
    const bookings = s.bookings.filter((b) => b.environment_id === id);
    const packed = packLanes(bookings);
    return { id, side, packed, conflicts: s.conflicts.filter((c) => c.environment_id === id), height: Math.max(1, packed.length) * LANE + 10 };
  }));

  return (
    <div className="review-envs">
      <Split
        width={width}
        names={(
          <>
            <div className="review-names-head" style={{ height: HEAD }}><span /><span>Environment</span><span /></div>
            {lanes.map((l) => (
              <div key={`${l.id}${l.side}`} className={`review-row review-lane-name${l.side === 'after' ? ' is-after' : ''}`} style={{ height: l.height }}>
                <span />
                <span className="review-task">{l.side === 'before' ? envById.get(l.id)?.name ?? 'Environment' : ''}</span>
                <span className="review-finish">{l.side === 'before' ? 'Now' : 'After'}</span>
              </div>
            ))}
          </>
        )}
        chart={(
          <>
            <ChartHead days={days} zoom={zoom} dayW={dayW} scale={scale} today={today} />
            {lanes.map((l) => {
              const env = envById.get(l.id);
              return (
                <svg key={`${l.id}${l.side}`} className={`gantt-body review-lane${l.side === 'after' ? ' is-after' : ''}`} width={width} height={l.height} viewBox={`0 0 ${width} ${l.height}`}
                  role="img" aria-label={`${env?.name ?? 'Environment'}, ${l.side === 'before' ? 'now' : 'after'}: ${l.conflicts.filter((c) => !c.resolved).length} double-bookings`}>
                  <defs>
                    <pattern id={`rv-hatch-${l.id}-${l.side}`} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                      <rect width="1.6" height="6" className="review-hatch-line" />
                    </pattern>
                  </defs>
                  <Grid days={days} zoom={zoom} dayW={dayW} height={l.height} holidays={holidays} />
                  {l.packed.map((lane, i) => lane.map((b) => {
                    const { x0, x1 } = spanX(scale, b.start_date, b.end_date, dayW);
                    const mine = b.project_id === projectId;
                    return (
                      <g key={b.id} className={`review-booking${mine ? ' is-mine' : ''}`} style={{ ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'var(--muted)' } as CSSProperties}>
                        <title>{`${b.project_name}: ${formatRange(b.start_date, b.end_date)}`}</title>
                        <rect x={x0 + 1} y={6 + i * LANE} width={Math.max(2, x1 - x0 - 2)} height={LANE - 6} rx={2} />
                        {x1 - x0 > 50 && <text x={x0 + 6} y={6 + i * LANE + 12}>{b.project_name}</text>}
                      </g>
                    );
                  }))}
                  {l.conflicts.map((c) => {
                    const { x0, x1 } = spanX(scale, c.start_date, c.end_date, dayW);
                    return (
                      <rect key={`${c.start_date}${c.booking_ids.join('-')}`} className={`review-clash${c.resolved ? ' is-resolved' : ''}`}
                        x={x0} y={3} width={Math.max(2, x1 - x0)} height={l.height - 6} fill={c.resolved ? undefined : `url(#rv-hatch-${l.id}-${l.side})`}>
                        <title>{`${c.resolved ? 'Accepted double-booking' : 'Double-booked'} ${formatRange(c.start_date, c.end_date)}: ${c.projects.map((p) => p.name).join(', ')}`}</title>
                      </rect>
                    );
                  })}
                </svg>
              );
            })}
          </>
        )}
      />
      <p className="review-legend">Each environment shows now, then after. Hatched red is a double-booking; your project’s bookings are in the environment’s colour.</p>
    </div>
  );
}

// ---------------------------------------------------------------- budget

/** What the plan costs bottom-up before and after, and the tasks whose cost moves. */
function ReviewBudget({ cost }: { cost: NonNullable<PlanReview['diff']['cost']> }) {
  const m = (n: number) => formatMoney(n, cost.currency);
  const change = cost.after - cost.before;
  return (
    <div className="review-budget">
      <dl className="review-budget-totals">
        <div><dt>Planned cost now</dt><dd>{m(cost.before)}</dd></div>
        <div><dt>After this change</dt><dd>{m(cost.after)}</dd></div>
        <div><dt>Difference</dt><dd className={change > 0 ? 'is-worse' : undefined}>{change === 0 ? 'none' : `${change > 0 ? '+' : '−'}${m(Math.abs(change))}`}</dd></div>
      </dl>
      {cost.tasks.length > 0 ? (
        <table className="budget-table">
          <thead><tr><th scope="col">Task</th><th scope="col" className="n">Now</th><th scope="col" className="n">After</th></tr></thead>
          <tbody>
            {cost.tasks.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.label}</th>
                <td className="n">{t.before == null ? '—' : m(t.before)}</td>
                <td className="n">{t.after == null ? '—' : m(t.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p className="review-legend">No task’s cost changes: the same days, people and fixed costs.</p>}
      <p className="review-legend">Planned cost is each task’s working days × its people’s day rates, plus its fixed cost. A shorter task with the same people costs less; crashing it with more people can cost more.</p>
    </div>
  );
}

// ---------------------------------------------------------------- people

function ReviewPeople({ review, people, holidays, today, zoom }: {
  review: PlanReview;
  people: ReadonlyMap<number, Resource>;
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  zoom: Zoom;
}) {
  const ids = review.diff.resource_ids;
  const dates = [...review.before.work, ...review.after.work].flatMap((w) => [w.start, w.end]);
  const { scale, days, dayW } = useScale(dates, zoom, today);
  if (!ids.length) return <div className="empty"><p>No change to anyone’s work. Nobody’s tasks move and no overlap comes or goes.</p></div>;
  if (!scale) return null;
  const width = days.length * dayW;
  const H = 26;
  const rows = ids.flatMap((r) => (['before', 'after'] as const).map((side) => ({ r, side, load: loadByDay(review[side].work, r, days) })));
  const opened = new Set(review.diff.overlaps_opened.map((x) => x.resource_id));
  const cleared = new Set(review.diff.overlaps_cleared.map((x) => x.resource_id));

  return (
    <div className="review-people">
      <Split
        width={width}
        names={(
          <>
            <div className="review-names-head" style={{ height: HEAD }}><span /><span>Person</span><span /></div>
            {rows.map(({ r, side }) => (
              <div key={`${r}${side}`} className={`review-row review-lane-name${side === 'after' ? ' is-after' : ''}`} style={{ height: H }}>
                <span />
                <span className="review-task">
                  {side === 'before' ? people.get(r)?.name ?? 'Someone' : ''}
                  {side === 'after' && opened.has(r) && <span className="review-tag is-worse">new overlap</span>}
                  {side === 'after' && cleared.has(r) && <span className="review-tag">overlap cleared</span>}
                </span>
                <span className="review-finish">{side === 'before' ? 'Now' : 'After'}</span>
              </div>
            ))}
          </>
        )}
        chart={(
          <>
            <ChartHead days={days} zoom={zoom} dayW={dayW} scale={scale} today={today} />
            {rows.map(({ r, side, load }) => (
              <svg key={`${r}${side}`} className={`gantt-body review-lane${side === 'after' ? ' is-after' : ''}`} width={width} height={H} viewBox={`0 0 ${width} ${H}`}
                role="img" aria-label={`${people.get(r)?.name ?? 'Someone'}, ${side === 'before' ? 'now' : 'after'}: ${load.filter((n) => n > 1).length} days on two things at once`}>
                <Grid days={days} zoom={zoom} dayW={dayW} height={H} holidays={holidays} />
                {load.map((n, i) => n > 0 && (
                  <g key={i} className={`review-load${n > 1 ? ' is-over' : ''}`}>
                    <title>{`${formatDate(days[i])}: ${n === 1 ? 'on one task' : `on ${n} tasks at once`}`}</title>
                    <rect x={i * dayW + 0.5} y={n > 1 ? 3 : 13} width={Math.max(1, dayW - 1)} height={n > 1 ? H - 6 : H - 16} />
                    {n > 1 && dayW >= 16 && <text x={i * dayW + dayW / 2} y={H / 2 + 4}>{n}×</text>}
                  </g>
                ))}
              </svg>
            ))}
          </>
        )}
      />
      <p className="review-legend">A short block is a day on one task. A tall ink block is a day on two or more at once.</p>
    </div>
  );
}
