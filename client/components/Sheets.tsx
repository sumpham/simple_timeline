import { useEffect, useRef, type ReactNode } from 'react';
import type { BookingView, Conflict, Environment, Team } from '../../shared/types.ts';
import type { DragMode } from '../dragMath.ts';
import { formatDate, formatRange } from '../layout.ts';
import { ENV_COLOR, MarkerIcon } from './Board.tsx';

/**
 * A panel that rises from the bottom of a phone screen, above the bottom bar.
 * Non-modal on purpose: the board stays live above it, so nudging a booking's
 * dates shows the bar, and any double-booking it makes, move while you tap.
 */
export function Sheet({
  label, onClose, scrim = false, className = '', children,
}: {
  label: string;
  onClose: () => void;
  /** Dim and block the board, for sheets that are about choosing, not editing. */
  scrim?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLElement>(null);
  const swipe = useRef<number | null>(null);
  // Callers pass a fresh arrow each render; focusing on every render would pull
  // focus off the stepper a user is tapping.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCloseRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      {scrim && <div className="sheet-scrim" onClick={onClose} aria-hidden="true" />}
      <section ref={ref} className={`sheet ${className}`} role="dialog" aria-label={label} tabIndex={-1}>
        <button
          type="button"
          className="sheet-grip"
          aria-label={`Close ${label.toLowerCase()}`}
          onPointerDown={(e) => { swipe.current = e.clientY; }}
          onPointerUp={(e) => {
            // A downward swipe or a tap on the grip both put the sheet away.
            if (swipe.current != null && e.clientY - swipe.current > -8) onClose();
            swipe.current = null;
          }}
          onClick={(e) => { if (e.detail === 0) onClose(); }}
        />
        {children}
      </section>
    </>
  );
}

function Stepper({
  label, value, earlier, later, onStep,
}: {
  label: string;
  value: string;
  earlier: string;
  later: string;
  onStep: (days: -1 | 1) => void;
}) {
  return (
    <div className="stepper">
      <span className="stepper-label">{label}</span>
      <span className="stepper-value">{value}</span>
      <button type="button" className="stepper-btn" aria-label={earlier} onClick={() => onStep(-1)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
      </button>
      <button type="button" className="stepper-btn" aria-label={later} onClick={() => onStep(1)}>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 3 5 5-5 5" /></svg>
      </button>
    </div>
  );
}

/**
 * What a tap on a bar opens on a phone: the facts, and day-by-day date changes.
 * The steppers run through the same nudge as the arrow keys, so a run of taps is
 * one save and the conflict preview follows every tap.
 */
export function BookingSheet({
  booking, inConflict, onNudge, onEdit, onClose,
}: {
  booking: BookingView;
  inConflict: boolean;
  onNudge: (mode: DragMode, days: -1 | 1) => void;
  onEdit: () => void;
  onClose: () => void;
}) {
  const marker = booking.kind === 'CUSTOM' ? booking.marker : null;
  const days = booking.working_days;

  return (
    <Sheet label="Booking" onClose={onClose} className="booking-sheet">
      <div className="sheet-body">
        <div className="booking-sheet-head">
          <h2>
            {marker && <MarkerIcon marker={marker} className="booking-sheet-marker" />}
            {booking.project_name}
          </h2>
          {inConflict && <span className="clash-badge">Double-booked</span>}
        </div>
        <p className="booking-sheet-meta">
          <span className="env-dot" style={{ ['--env-color' as string]: ENV_COLOR[booking.env_kind] }} />
          {booking.env_name}, {formatRange(booking.start_date, booking.end_date)}
          {!booking.is_milestone && `, ${days} working day${days === 1 ? '' : 's'}`}
          {booking.confidence === 'tentative' && ', tentative'}
        </p>
        {booking.note && <p className="booking-sheet-note">{booking.note}</p>}

        <div className="steppers">
          {booking.is_milestone ? (
            <Stepper
              label="Date"
              value={formatDate(booking.start_date)}
              earlier="One day earlier"
              later="One day later"
              onStep={(d) => onNudge('move', d)}
            />
          ) : (
            <>
              <Stepper
                label="Starts"
                value={formatDate(booking.start_date)}
                earlier="Start one day earlier"
                later="Start one day later"
                onStep={(d) => onNudge('resize-start', d)}
              />
              <Stepper
                label="Ends"
                value={formatDate(booking.end_date)}
                earlier="End one day earlier"
                later="End one day later"
                onStep={(d) => onNudge('resize-end', d)}
              />
              <Stepper
                label="Move"
                value="whole booking"
                earlier="Move one day earlier"
                later="Move one day later"
                onStep={(d) => onNudge('move', d)}
              />
            </>
          )}
        </div>
      </div>
      <div className="sheet-foot">
        <button type="button" className="btn quiet" onClick={onEdit}>Edit details</button>
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </div>
    </Sheet>
  );
}

export function EnvFilter({
  environments, hidden, conflicts, onToggle,
}: {
  environments: Environment[];
  hidden: Set<number>;
  conflicts: Conflict[];
  onToggle: (id: number) => void;
}) {
  return (
    <div className="filter-list">
      {environments.map((env) => {
        const count = conflicts.filter((c) => c.environment_id === env.id).length;
        return (
          <label key={env.id} className="filter-item">
            <input type="checkbox" checked={!hidden.has(env.id)} onChange={() => onToggle(env.id)} />
            <span className="env-dot" style={{ ['--env-color' as string]: ENV_COLOR[env.kind] }} />
            {env.name}
            {count > 0 && <span className="count over">{count}</span>}
          </label>
        );
      })}
    </div>
  );
}

/** Team, environment filter and the managers: everything the phone's top bar folds away. */
export function BoardSheet({
  teams, teamId, environments, hidden, conflicts, onSelectTeam, onToggleEnv, onManage, onClose,
}: {
  teams: Team[];
  teamId: number | null;
  environments: Environment[];
  hidden: Set<number>;
  conflicts: Conflict[];
  onSelectTeam: (id: number) => void;
  onToggleEnv: (id: number) => void;
  onManage: (what: 'teams' | 'projects' | 'environments') => void;
  onClose: () => void;
}) {
  return (
    <Sheet label="Board settings" onClose={onClose} scrim className="board-sheet">
      <div className="sheet-body">
        <h2 className="sheet-section">Team</h2>
        <div className="team-picker" role="group" aria-label="Team">
          {teams.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-pressed={t.id === teamId}
              onClick={() => onSelectTeam(t.id)}
            >
              <span>{t.name}</span>
              <span className="team-picker-code">{t.code}</span>
            </button>
          ))}
        </div>

        {environments.length > 0 && (
          <>
            <h2 className="sheet-section">Show environments</h2>
            <EnvFilter environments={environments} hidden={hidden} conflicts={conflicts} onToggle={onToggleEnv} />
          </>
        )}
      </div>
      <div className="sheet-foot manage">
        <button type="button" className="btn quiet" onClick={() => onManage('teams')}>Teams</button>
        {teamId != null && (
          <>
            <button type="button" className="btn quiet" onClick={() => onManage('projects')}>Projects</button>
            <button type="button" className="btn quiet" onClick={() => onManage('environments')}>Environments</button>
          </>
        )}
      </div>
    </Sheet>
  );
}
