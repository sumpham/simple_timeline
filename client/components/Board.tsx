import { useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from 'react';
import { addDays, diffDays, toUTC, workingDays as countWorkingDays } from '../../shared/dates.ts';
import type { BookingView, Conflict, EnvKind, Environment, Holiday, ISODate, Marker, Project } from '../../shared/types.ts';
import { nextBookingAfter, occupancyOn, openConflicts } from '../../shared/conflicts.ts';
import { formatDate, formatRange, laneCount, majorTicks, minorTicks, packLanes, type Scale } from '../layout.ts';
import { PROVISIONAL_ID, type DragMode, type QuickPlan } from '../dragMath.ts';
import { LONG_PRESS_MS, TOUCH_SLOP_PX } from '../touch.ts';
import type { DragSession } from '../useBookingDrag.ts';

export type Mode = 'environment' | 'project';

export const ENV_COLOR: Record<EnvKind, string> = {
  SIT: 'var(--env-sit)',
  UAT: 'var(--env-uat)',
  NFT: 'var(--env-nft)',
  PENTEST: 'var(--env-pentest)',
  PROD: 'var(--env-prod)',
  OTHER: 'var(--env-other)',
};

const MARKER_PATHS: Record<Marker, string> = {
  star: 'M12 2.5l2.9 6.1 6.6.8-4.9 4.6 1.3 6.6L12 17.3l-5.9 3.3 1.3-6.6-4.9-4.6 6.6-.8z',
  flag: 'M5 2h2.2v20H5zM8.2 3H19l-2.6 4.6L19 12.2H8.2z',
  pin: 'M12 2a7 7 0 0 0-7 7c0 5.2 7 13 7 13s7-7.8 7-13a7 7 0 0 0-7-7zm0 9.6a2.6 2.6 0 1 1 0-5.2 2.6 2.6 0 0 1 0 5.2z',
};

/** The glyph a CUSTOM booking carries. Filled with currentColor, so the caller sets the hue. */
export function MarkerIcon({ marker, className }: { marker: Marker; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path d={MARKER_PATHS[marker]} fill="currentColor" fillRule="evenodd" />
    </svg>
  );
}

export type Row = {
  key: string;
  id: number;
  name: string;
  meta: string;
  kind: EnvKind;
  bookings: BookingView[];
  conflicts: Conflict[];
  /** Live occupancy readout for environment rows: booked against capacity. */
  occupancy?: { booked: number; capacity: number };
  /** A project that has never been booked; shown so it can still be reached. */
  empty?: boolean;
  /**
   * Who holds an environment today, or who is next. On a phone there is no room
   * for the occupancy strip, so each lane header says it instead.
   */
  status?: { text: string; clash: boolean };
};

const ROW_PAD = 7;
const BAR_H = 22;
const BAR_GAP = 4;
/** The band above each lane that names it when there is no rail beside it. */
export const LANE_HEAD_H = 26;

/** Matches the drag hook: a press that moves less than this is a click. */
const CLICK_SLOP_PX = 4;

/**
 * The shortest a row may be: enough for the rail's two lines (name, then booking
 * count) beside it. A one-lane row at bar height alone is 36px, and the rail's
 * second line spilled into the row below.
 */
const ROW_MIN_H = 44;

function rowHeight(lanes: number): number {
  return Math.max(ROW_MIN_H, ROW_PAD * 2 + lanes * BAR_H + (lanes - 1) * BAR_GAP);
}

function laneStatus(
  bookings: BookingView[], env: Environment, today: ISODate, conflicts: Conflict[],
): Row['status'] {
  const holders = occupancyOn(bookings, env.id, today);
  if (holders.length > env.capacity) {
    // Over capacity today, but only an unresolved clash is shown as one.
    const clash = conflicts.some((c) => !c.resolved && c.start_date <= today && c.end_date >= today);
    return { text: `${holders.length} projects, room for ${env.capacity}`, clash };
  }
  if (holders.length === 1) {
    return { text: `${holders[0].project_name} until ${formatDate(holders[0].end_date)}`, clash: false };
  }
  if (holders.length > 1) return { text: `${holders.length} of ${env.capacity} booked`, clash: false };
  const next = nextBookingAfter(bookings, env.id, today);
  return { text: next ? `Free, next ${next.project_name} ${formatDate(next.start_date)}` : 'Free', clash: false };
}

/** Bookings grouped into the rows the current mode calls for. */
export function buildRows(
  mode: Mode,
  data: { bookings: BookingView[]; projects: Project[]; environments: Environment[]; conflicts: Conflict[] },
  visibleEnvIds: Set<number>,
  today: ISODate,
): Row[] {
  if (mode === 'environment') {
    return data.environments
      .filter((env) => visibleEnvIds.has(env.id))
      .map((env) => {
        const bookings = data.bookings.filter((b) => b.environment_id === env.id);
        const conflicts = data.conflicts.filter((c) => c.environment_id === env.id);
        const booked = bookings.filter(
          (b) => !b.is_milestone && b.start_date <= today && b.end_date >= today,
        ).length;
        return {
          key: `env-${env.id}`,
          id: env.id,
          name: env.name,
          meta: `${bookings.length} booking${bookings.length === 1 ? '' : 's'}`,
          kind: env.kind,
          bookings,
          conflicts,
          occupancy: { booked, capacity: env.capacity },
          status: laneStatus(data.bookings, env, today, conflicts),
        };
      });
  }

  const conflictedIds = new Set(data.conflicts.flatMap((c) => c.booking_ids));
  return data.projects
    .map((project) => {
      const bookings = data.bookings.filter(
        (b) => b.project_id === project.id && visibleEnvIds.has(b.environment_id),
      );
      // A project row is conflicted when any of its own bookings are involved.
      const conflicts = data.conflicts.filter((c) =>
        c.booking_ids.some((id) => bookings.some((b) => b.id === id)),
      );
      // Prefer the server's total, which counts bookings outside the window too,
      // but fall back to what is in view so a missing count cannot fake an empty project.
      const inWindow = data.bookings.filter((b) => b.project_id === project.id).length;
      const total = project.booking_count ?? inWindow;
      return {
        key: `proj-${project.id}`,
        id: project.id,
        name: project.name,
        meta: total === 0
          ? 'nothing booked yet'
          : (project.owner ? `${project.owner} · ${project.priority}` : project.priority),
        kind: 'OTHER' as EnvKind,
        bookings,
        conflicts: conflicts.filter((c) => c.booking_ids.some((id) => conflictedIds.has(id))),
        empty: total === 0,
      };
    })
    // A project with no bookings anywhere still gets a row, or it would be
    // invisible and unreachable. One whose bookings are merely filtered out does not.
    .filter((row) => row.bookings.length > 0 || row.empty);
}

export function rowHeights(rows: readonly Row[], dayWidth: number): number[] {
  return rows.map((row) => rowHeight(laneCount(packLanes(row.bookings, dayWidth))));
}

type BoardProps = {
  rows: Row[];
  scale: Scale;
  holidays: Holiday[];
  today: ISODate;
  mode: Mode;
  gridRef: RefObject<HTMLDivElement>;
  onScroll: (scrollTop: number) => void;
  onSelectBooking: (booking: BookingView) => void;
  onDragStart: (booking: BookingView, mode: DragMode, event: React.PointerEvent) => void;
  onNudge: (booking: BookingView, mode: DragMode, days: number) => void;
  drag: DragSession | null;
  animate: boolean;
  /** Phone layout: no rail, so each lane carries its own header. */
  compact?: boolean;
  /** A bar picked up by a long press, showing its resize tabs. */
  picked?: number | null;
  /**
   * Extra scroll room below the last row. The rail's environment filter covers
   * the foot of the rail, so without it the last rows could never scroll clear.
   */
  tailSpace?: number;
  onEditRow?: (row: Row) => void;
  /** What a long press here would book; absent or null when nothing can be. */
  planAt?: (row: Row, date: ISODate) => QuickPlan | null;
  /** A long press on empty lane space was held and released: book it. */
  onCreate?: (plan: QuickPlan) => void;
  /** A plain click on empty lane space, which books nothing, so say how. */
  onHint?: () => void;
};

/**
 * The first ten characters of a booking's note, for the bar itself. One project
 * often books the same environment several times for different work (NFT, SIT
 * rerun, …); the tag is what tells those bars apart at a glance.
 */
export const NOTE_TAG_LEN = 10;
export function noteTag(note: string | null | undefined): string | null {
  const flat = (note ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return null;
  const chars = Array.from(flat);
  return chars.length > NOTE_TAG_LEN ? `${chars.slice(0, NOTE_TAG_LEN).join('').trimEnd()}…` : flat;
}

/**
 * The note as a bar shows it: whole when label and note both fit in the room the
 * bar has, otherwise the short tag. `measure` returns rendered widths in pixels,
 * so the choice follows the real font rather than a character count.
 */
export function barNote(
  label: string,
  note: string | null | undefined,
  room: number,
  measure: (label: string, note: string) => number,
): string | null {
  const tag = noteTag(note);
  if (!tag) return null;
  const full = (note ?? '').replace(/\s+/g, ' ').trim();
  return full !== tag && measure(label, ` · ${full}`) <= room ? full : tag;
}

/** Horizontal padding inside a bar, both sides (see `.bar` in styles.css). */
const BAR_PAD_X = 14;
/** A marker icon's width plus its gap, when the bar carries one. */
const BAR_MARKER_W = 17;

let measureCtx: CanvasRenderingContext2D | null | undefined;

/**
 * Width of a bar's text as drawn: the label in the bar's semibold, the note in
 * regular weight. Uses the loaded web font, which is why Board waits on
 * `document.fonts.ready` before trusting these numbers.
 */
function measureBarText(label: string, note: string): number {
  if (measureCtx === undefined) measureCtx = document.createElement('canvas').getContext('2d');
  const ctx = measureCtx;
  if (!ctx) return Infinity;
  const family = "'Archivo Narrow', 'Archivo', sans-serif";
  ctx.font = `600 11px ${family}`;
  const a = ctx.measureText(label).width;
  ctx.font = `400 11px ${family}`;
  return a + ctx.measureText(note).width;
}

export function Board({
  rows, scale, holidays, today, mode, gridRef, onScroll, onSelectBooking,
  onDragStart, onNudge, drag, animate, compact = false, picked = null, onEditRow, planAt, onCreate, onHint,
  tailSpace = 0,
}: BoardProps) {
  // Bars measure their text to decide whether a whole note fits; until the web
  // font has loaded those widths are the fallback font's, so draw again once it has.
  const [, setFontsLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void document.fonts?.ready.then(() => { if (live) setFontsLoaded(true); });
    return () => { live = false; };
  }, []);

  const major = useMemo(() => majorTicks(scale), [scale]);
  const minor = useMemo(() => minorTicks(scale), [scale]);

  const todayX = scale.x(today);
  const todayVisible = toUTC(today) >= toUTC(scale.from) && toUTC(today) <= toUTC(scale.to);

  const visibleHolidays = holidays.filter(
    (h) => toUTC(h.date) >= toUTC(scale.from) && toUTC(h.date) <= toUTC(scale.to),
  );

  return (
    <div
      className="grid"
      ref={gridRef}
      onScroll={(e) => onScroll(e.currentTarget.scrollTop)}
    >
      <div className="grid-inner" style={{ width: scale.width, '--day': `${scale.dayWidth}px` } as CSSProperties}>
        <div className="ruler">
          <div className="ruler-band major">
            {major.map((tick) => (
              <div key={tick.date} className="tick major" style={{ left: scale.x(tick.date) }}>
                {tick.label}
              </div>
            ))}
          </div>
          <div className="ruler-band">
            {minor.map((tick) => {
              const dow = new Date(toUTC(tick.date)).getUTCDay();
              const weekend = scale.zoom === 'week' && (dow === 0 || dow === 6);
              return (
                <div
                  key={tick.date}
                  className={`tick${weekend ? ' is-weekend' : ''}`}
                  style={{ left: scale.x(tick.date) }}
                >
                  {tick.label}
                </div>
              );
            })}
          </div>
          {todayVisible && <div className="today-flag" style={{ left: todayX }}>Today</div>}
        </div>

        <div className={`rows${animate ? ' animate-in' : ''}${scale.dayWidth < 6 ? ' dense' : ''}`}>
          {visibleHolidays.map((h) => (
            <div
              key={h.date}
              className="holiday-col"
              style={{ left: scale.x(h.date), width: scale.dayWidth }}
              title={h.name}
            />
          ))}
          {todayVisible && <div className="today-line" style={{ left: todayX }} />}

          {rows.map((row) => (
            <BoardRow
              key={row.key}
              row={row}
              scale={scale}
              mode={mode}
              onSelectBooking={onSelectBooking}
              onDragStart={onDragStart}
              onNudge={onNudge}
              dragId={drag?.booking.id ?? null}
              compact={compact}
              picked={picked}
              onEditRow={onEditRow}
              planAt={planAt}
              onCreate={onCreate}
              onHint={onHint}
            />
          ))}
        </div>
        {tailSpace > 0 && <div className="grid-tail" style={{ height: tailSpace }} aria-hidden="true" />}
      </div>
    </div>
  );
}

function BoardRow({
  row, scale, mode, onSelectBooking, onDragStart, onNudge, dragId, compact, picked, onEditRow,
  planAt, onCreate, onHint,
}: {
  row: Row;
  scale: Scale;
  mode: Mode;
  onSelectBooking: (b: BookingView) => void;
  onDragStart: (b: BookingView, mode: DragMode, e: React.PointerEvent) => void;
  onNudge: (b: BookingView, mode: DragMode, days: number) => void;
  dragId: number | null;
  compact: boolean;
  picked: number | null;
  onEditRow?: (row: Row) => void;
  planAt?: (row: Row, date: ISODate) => QuickPlan | null;
  onCreate?: (plan: QuickPlan) => void;
  onHint?: () => void;
}) {
  const placed = useMemo(() => packLanes(row.bookings, scale.dayWidth), [row.bookings, scale.dayWidth]);
  const lanes = laneCount(placed);
  const head = compact ? LANE_HEAD_H : 0;
  const height = rowHeight(lanes) + head;
  const over = row.occupancy && row.occupancy.booked > row.occupancy.capacity;
  // Resolved clashes are still drawn, in green, but only open ones raise the alarm.
  const alarming = useMemo(() => openConflicts(row.conflicts), [row.conflicts]);
  const conflictedIds = useMemo(
    () => new Set(alarming.flatMap((c) => c.booking_ids)),
    [alarming],
  );

  /**
   * Booking by long press on empty lane space. A plain click books nothing: it is
   * too easy to make by accident, and a save that takes a moment looked like one
   * that had failed. Held still for LONG_PRESS_MS, the press arms and the preview
   * fills in; releasing then books. Moving off, Escape, or the browser taking the
   * touch for a scroll all abandon it.
   */
  const [hold, setHold] = useState<{ plan: QuickPlan; armed: boolean } | null>(null);
  const holdRef = useRef<{ cleanup: () => void } | null>(null);
  useEffect(() => () => holdRef.current?.cleanup(), []);

  const onPointerDownCapture = (e: React.PointerEvent<HTMLDivElement>) => {
    holdRef.current?.cleanup();
    if (!planAt || e.button !== 0) return;
    // A bar or a lane header owns its own press, and a touch that puts a
    // picked-up bar back down is not a request for a new booking.
    if (e.target instanceof Element && e.target.closest('.bar, .lane-head')) return;
    if (picked != null) return;

    const offset = e.clientX - e.currentTarget.getBoundingClientRect().left;
    const plan = planAt(row, addDays(scale.from, Math.floor(offset / scale.dayWidth)));
    if (!plan) return;

    const { pointerId, clientX: x0, clientY: y0 } = e;
    const slop = e.pointerType === 'touch' ? TOUCH_SLOP_PX : CLICK_SLOP_PX;
    // A mouse held still on the lane must not start a text selection.
    if (e.pointerType === 'mouse') e.preventDefault();
    let armed = false;

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', cleanup);
      window.removeEventListener('keydown', onKey);
      holdRef.current = null;
      setHold(null);
    };
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId && Math.hypot(ev.clientX - x0, ev.clientY - y0) > slop) cleanup();
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      cleanup();
      if (armed) onCreate?.(plan);
      else onHint?.();
    };
    const onKey = (ev: KeyboardEvent) => { if (ev.key === 'Escape') cleanup(); };
    const timer = setTimeout(() => {
      armed = true;
      navigator.vibrate?.(12);
      setHold({ plan, armed: true });
    }, LONG_PRESS_MS);

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    // The browser took the touch for a scroll.
    window.addEventListener('pointercancel', cleanup);
    window.addEventListener('keydown', onKey);
    holdRef.current = { cleanup };
    setHold({ plan, armed: false });
  };

  const ghost = hold && (() => {
    const { span, kind, env, project } = hold.plan;
    const single = kind === 'RELEASE' || span.start === span.end;
    const end = kind === 'RELEASE' ? span.start : span.end;
    return (
      <div
        className={`hold-ghost${hold.armed ? ' armed' : ''}`}
        aria-hidden="true"
        style={{
          left: scale.x(span.start),
          width: Math.max(scale.spanWidth(span.start, end), single ? 14 : 0),
          top: head + ROW_PAD,
          '--env-color': ENV_COLOR[env.kind] ?? ENV_COLOR.OTHER,
          '--hold-ms': `${LONG_PRESS_MS}ms`,
        } as CSSProperties}
      >
        <span className="hold-ghost-label">
          {hold.armed ? 'Release to book ' : ''}{mode === 'environment' ? project.name : env.name}
        </span>
      </div>
    );
  })();

  return (
    <div
      className={`row${alarming.length ? ' is-conflicted' : ''}${planAt ? ' can-book' : ''}${hold ? ' is-holding' : ''}`}
      style={{ height }}
      data-row={row.key}
      onPointerDownCapture={onPointerDownCapture}
      // A long press on a phone would otherwise raise the system menu.
      onContextMenu={planAt ? (e) => { if (!(e.target instanceof Element && e.target.closest('.bar'))) e.preventDefault(); } : undefined}
    >
      {compact && (
        <div className="lane-head">
          <button type="button" className="lane-head-label" onClick={() => onEditRow?.(row)}>
            {mode === 'environment' && (
              <span className="env-dot" style={{ ['--env-color' as string]: ENV_COLOR[row.kind] }} />
            )}
            <span className="lane-head-name">{row.name}</span>
            {row.occupancy && (
              <span className={`occupancy${over ? ' over' : ''}`}>
                {row.occupancy.booked}/{row.occupancy.capacity}
              </span>
            )}
            <span className={`lane-head-status${row.status?.clash ? ' clash' : ''}`}>
              {row.status?.text ?? row.meta}
            </span>
          </button>
        </div>
      )}
      {/* In environment mode the whole lane is over capacity for these days, so the
          hatch spans the row. In project mode it would double-count, so it is omitted. */}
      {mode === 'environment' &&
        row.conflicts.map((c) => (
          <div
            key={`hatch-${c.start_date}`}
            className={`conflict-span${c.resolved ? ' is-resolved' : ''}`}
            style={{
              top: head,
              left: scale.x(c.start_date),
              width: scale.spanWidth(c.start_date, c.end_date),
            }}
          />
        ))}

      {/* Drawn after the bars so the collision reads through the stack. */}
      {mode === 'environment' &&
        row.conflicts.map((c) => (
          <div
            key={`frame-${c.start_date}`}
            className={`conflict-frame${c.resolved ? ' is-resolved' : ''}`}
            data-days={scale.spanWidth(c.start_date, c.end_date) >= 30 ? `${c.overlap_days}d` : undefined}
            style={{
              top: head,
              left: scale.x(c.start_date),
              width: scale.spanWidth(c.start_date, c.end_date),
            }}
          />
        ))}

      {placed.map(({ booking, lane }) => (
        <Bar
          key={booking.id}
          booking={booking}
          lane={lane}
          top={head}
          scale={scale}
          mode={mode}
          inConflict={conflictedIds.has(booking.id)}
          onSelect={onSelectBooking}
          onDragStart={onDragStart}
          onNudge={onNudge}
          dragging={dragId === booking.id}
          picked={picked === booking.id}
        />
      ))}
      {ghost}
    </div>
  );
}

function Bar({
  booking, lane, top: offset, scale, mode, inConflict, onSelect, onDragStart, onNudge, dragging, picked,
}: {
  booking: BookingView;
  lane: number;
  top: number;
  scale: Scale;
  mode: Mode;
  inConflict: boolean;
  onSelect: (b: BookingView) => void;
  onDragStart: (b: BookingView, mode: DragMode, e: React.PointerEvent) => void;
  onNudge: (b: BookingView, mode: DragMode, days: number) => void;
  dragging: boolean;
  picked: boolean;
}) {
  const left = scale.x(booking.start_date);
  const top = offset + ROW_PAD + lane * (BAR_H + BAR_GAP);
  const color = ENV_COLOR[booking.env_kind] ?? ENV_COLOR.OTHER;

  // In environment mode the lane already names the environment, so the bar names
  // the project; in project mode it is the other way round.
  const label = mode === 'environment' ? booking.project_name : booking.env_name;
  const width = scale.spanWidth(booking.start_date, booking.end_date);

  const span = `${formatRange(booking.start_date, booking.end_date)}, ` +
    `${booking.working_days} working day${booking.working_days === 1 ? '' : 's'}`;
  const what = booking.is_milestone
    ? (booking.kind === 'RELEASE'
      ? `${booking.project_name} releases to ${booking.env_name} on ${formatRange(booking.start_date, booking.end_date)}`
      : `${booking.project_name} marks ${booking.env_name} on ${formatRange(booking.start_date, booking.end_date)}`)
    : `${booking.project_name} books ${booking.env_name}, ${span}${inConflict ? ' — double-booked' : ''}`;
  const description = booking.note ? `${what}. Note: ${booking.note}` : what;
  // Belt and braces: the server already clears markers on other kinds.
  const marker = booking.kind === 'CUSTOM' ? booking.marker : null;
  // Milestone labels float beside the glyph with no bound, and collide with the
  // next one; they keep the short tag. A bar shows the whole note when it fits.
  const noteText = booking.is_milestone
    ? noteTag(booking.note)
    : barNote(label, booking.note, width - BAR_PAD_X - (marker ? BAR_MARKER_W : 0), measureBarText);
  const tagged = noteText && <span className="bar-note"> · {noteText}</span>;

  // Resize handles need room to be grabbable; on a short bar they would leave
  // nothing to drag by, so only the move gesture is offered there.
  // A picked-up bar's tabs sit outside it, so even a short one can be resized.
  // The placeholder for a booking still being saved: drawn, but not yet editable.
  const saving = booking.id === PROVISIONAL_ID;
  const resizable = !saving && !booking.is_milestone && (width >= 26 || picked);

  const classes = [
    'bar',
    booking.is_milestone ? 'milestone' : '',
    marker ? 'has-marker' : '',
    booking.confidence === 'tentative' ? 'tentative' : '',
    inConflict && !booking.is_milestone ? 'in-conflict' : '',
    dragging ? 'is-dragging' : '',
    picked ? 'is-picked' : '',
    saving ? 'is-saving' : '',
  ].filter(Boolean).join(' ');

  /**
   * Keyboard editing mirrors the drag gestures, so the board is fully usable
   * without a pointer: arrows move, shift+arrows take the right edge, alt+arrows
   * the left. Plain Enter or Space still opens the booking.
   */
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const days = event.key === 'ArrowLeft' ? -1 : 1;
    const dragMode: DragMode = event.shiftKey ? 'resize-end' : event.altKey ? 'resize-start' : 'move';
    if (booking.is_milestone && dragMode !== 'move') return;
    event.preventDefault();
    event.stopPropagation();
    onNudge(booking, dragMode, days);
  };

  return (
    <button
      type="button"
      className={classes}
      data-booking={booking.id}
      style={{
        // Centre the glyph on its day: the diamond is 13px wide, a marker 16px.
        left: booking.is_milestone ? left + scale.dayWidth / 2 - (marker ? 8 : 6.5) : left,
        top,
        width: booking.is_milestone ? undefined : width,
        '--env-color': color,
        animationDelay: `${Math.min(280, Math.max(0, diffDays(scale.from, booking.start_date)) * 1.1)}ms`,
      } as CSSProperties}
      title={saving ? `${description}\nSaving…` : `${description}\nDrag to move${resizable ? ', drag an edge to resize' : ''}`}
      aria-label={saving ? `Saving: ${description}` : description}
      aria-busy={saving || undefined}
      tabIndex={saving ? -1 : undefined}
      onPointerDown={saving ? (e) => e.stopPropagation() : (e) => onDragStart(booking, 'move', e)}
      // A long press is how a phone picks a bar up; the system menu must not answer it.
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={saving ? undefined : onKeyDown}
      // Only a keyboard produces a click with no pointer detail; pointer clicks
      // are resolved by the drag hook so a drag never also opens the dialog.
      onClick={(e) => { if (e.detail === 0 && !saving) onSelect(booking); }}
    >
      {booking.is_milestone ? (
        <>
          {marker ? <MarkerIcon marker={marker} className="milestone-marker" /> : <span className="diamond" />}
          {scale.dayWidth >= 6 && <span className="milestone-label">{label}{tagged}</span>}
        </>
      ) : (
        <>
          {saving && <span className="bar-spinner" aria-hidden="true" />}
          {marker && width >= 18 && <MarkerIcon marker={marker} className="bar-marker" />}
          {width >= 34 && <span className="bar-clip">{label}{tagged}</span>}
        </>
      )}

      {resizable && (
        <>
          <span
            className="bar-handle start"
            onPointerDown={(e) => onDragStart(booking, 'resize-start', e)}
            aria-hidden="true"
          />
          <span
            className="bar-handle end"
            onPointerDown={(e) => onDragStart(booking, 'resize-end', e)}
            aria-hidden="true"
          />
        </>
      )}
    </button>
  );
}

/** Follows the pointer during a drag, stating exactly what will be saved. */
export function DragReadout({
  drag, clashes, holidays,
}: {
  drag: DragSession;
  clashes: boolean;
  holidays: ReadonlySet<ISODate>;
}) {
  const { span, booking } = drag;
  // Holidays count here too, or the readout disagrees with the saved booking.
  const days = countWorkingDays(span.start, span.end, holidays);

  return (
    <div
      className={`drag-readout${drag.touch ? ' pinned' : ''}`}
      // Under a finger the readout would be hidden by the finger itself, so it pins to the top.
      style={drag.touch ? undefined : { left: drag.x, top: drag.y }}
      role="status"
      aria-live="polite"
    >
      <div className="drag-readout-dates">{formatRange(span.start, span.end)}</div>
      <div className="drag-readout-meta">
        {booking.is_milestone
          ? `${booking.project_name} release`
          : `${days} working day${days === 1 ? '' : 's'}`}
        {clashes && <span className="drag-readout-clash">double-booked</span>}
      </div>
    </div>
  );
}

/** Shown when the filters leave nothing to draw. */
export function BoardEmpty({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="empty">
      <h2>Nothing to show</h2>
      <p>{message}</p>
      {action}
    </div>
  );
}

export { addDays };
