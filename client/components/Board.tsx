import { useMemo, useRef, type CSSProperties, type RefObject } from 'react';
import { addDays, diffDays, toUTC, workingDays as countWorkingDays } from '../../shared/dates.ts';
import type { BookingView, Conflict, EnvKind, Environment, Holiday, ISODate, Marker, Project } from '../../shared/types.ts';
import { nextBookingAfter, occupancyOn } from '../../shared/conflicts.ts';
import { formatDate, formatRange, laneCount, majorTicks, minorTicks, packLanes, type Scale } from '../layout.ts';
import type { DragMode } from '../dragMath.ts';
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

function rowHeight(lanes: number): number {
  return ROW_PAD * 2 + lanes * BAR_H + (lanes - 1) * BAR_GAP;
}

function laneStatus(bookings: BookingView[], env: Environment, today: ISODate): Row['status'] {
  const holders = occupancyOn(bookings, env.id, today);
  if (holders.length > env.capacity) {
    return { text: `${holders.length} projects, room for ${env.capacity}`, clash: true };
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
          status: laneStatus(data.bookings, env, today),
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
  onEditRow?: (row: Row) => void;
  /** A click on empty lane space: book this row from the clicked day. */
  onCreateAt?: (row: Row, date: ISODate) => void;
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

export function Board({
  rows, scale, holidays, today, mode, gridRef, onScroll, onSelectBooking,
  onDragStart, onNudge, drag, animate, compact = false, picked = null, onEditRow, onCreateAt,
}: BoardProps) {
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
              onCreateAt={onCreateAt}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

function BoardRow({
  row, scale, mode, onSelectBooking, onDragStart, onNudge, dragId, compact, picked, onEditRow, onCreateAt,
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
  onCreateAt?: (row: Row, date: ISODate) => void;
}) {
  const placed = useMemo(() => packLanes(row.bookings, scale.dayWidth), [row.bookings, scale.dayWidth]);
  const lanes = laneCount(placed);
  const head = compact ? LANE_HEAD_H : 0;
  const height = rowHeight(lanes) + head;
  const over = row.occupancy && row.occupancy.booked > row.occupancy.capacity;
  const conflictedIds = useMemo(
    () => new Set(row.conflicts.flatMap((c) => c.booking_ids)),
    [row.conflicts],
  );

  /**
   * Where a press on empty lane space began, and whether a bar was picked up at
   * the time. A press that travelled is a pan or a text selection, and a tap that
   * puts a picked-up bar down is not a request for a new booking.
   */
  const press = useRef<{ x: number; y: number; hadPick: boolean } | null>(null);

  // Capture phase: a bar stops its own pointerdown from bubbling, and a drag that
  // starts on a bar and ends on empty space must not leave a stale press behind.
  const onPointerDownCapture = (e: React.PointerEvent) => {
    const onBar = e.target instanceof Element && e.target.closest('.bar, .lane-head');
    press.current = onBar ? null : { x: e.clientX, y: e.clientY, hadPick: picked != null };
  };

  const onClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const p = press.current;
    press.current = null;
    if (!onCreateAt || !p || p.hadPick) return;
    if (e.target instanceof Element && e.target.closest('.bar, .lane-head')) return;
    if (Math.hypot(e.clientX - p.x, e.clientY - p.y) > CLICK_SLOP_PX) return;
    const offset = e.clientX - e.currentTarget.getBoundingClientRect().left;
    onCreateAt(row, addDays(scale.from, Math.floor(offset / scale.dayWidth)));
  };

  return (
    <div
      className={`row${row.conflicts.length ? ' is-conflicted' : ''}${onCreateAt ? ' can-book' : ''}`}
      style={{ height }}
      data-row={row.key}
      onPointerDownCapture={onPointerDownCapture}
      onClick={onClick}
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
            className="conflict-span"
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
            className="conflict-frame"
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
  const tag = noteTag(booking.note);
  const tagged = tag && <span className="bar-note"> · {tag}</span>;

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

  // Resize handles need room to be grabbable; on a short bar they would leave
  // nothing to drag by, so only the move gesture is offered there.
  // A picked-up bar's tabs sit outside it, so even a short one can be resized.
  const resizable = !booking.is_milestone && (width >= 26 || picked);

  const classes = [
    'bar',
    booking.is_milestone ? 'milestone' : '',
    marker ? 'has-marker' : '',
    booking.confidence === 'tentative' ? 'tentative' : '',
    inConflict && !booking.is_milestone ? 'in-conflict' : '',
    dragging ? 'is-dragging' : '',
    picked ? 'is-picked' : '',
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
      title={`${description}\nDrag to move${resizable ? ', drag an edge to resize' : ''}`}
      aria-label={description}
      onPointerDown={(e) => onDragStart(booking, 'move', e)}
      // A long press is how a phone picks a bar up; the system menu must not answer it.
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={onKeyDown}
      // Only a keyboard produces a click with no pointer detail; pointer clicks
      // are resolved by the drag hook so a drag never also opens the dialog.
      onClick={(e) => { if (e.detail === 0) onSelect(booking); }}
    >
      {booking.is_milestone ? (
        <>
          {marker ? <MarkerIcon marker={marker} className="milestone-marker" /> : <span className="diamond" />}
          {scale.dayWidth >= 6 && <span className="milestone-label">{label}{tagged}</span>}
        </>
      ) : (
        <>
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
