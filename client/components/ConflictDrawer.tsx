import type { Conflict } from '../../shared/types.ts';
import { formatRange } from '../layout.ts';

type ResolveHandler = (c: Conflict, resolved: boolean) => void;

/** Shared by the desktop drawer and the phone's pull-up sheet. */
export function ConflictList({
  conflicts, onSelect, onResolve,
}: {
  conflicts: Conflict[];
  onSelect: (c: Conflict) => void;
  onResolve?: ResolveHandler;
}) {
  if (conflicts.length === 0) {
    return (
      <p className="drawer-empty">
        No double-bookings in this range. Every environment is booked within its capacity.
      </p>
    );
  }

  return (
    <>
      {conflicts.map((c) => (
        // A card holds two actions, so it is a group, not one big button.
        <div
          key={`${c.environment_id}-${c.start_date}`}
          className={`conflict-card${c.resolved ? ' is-resolved' : ''}`}
        >
          <button type="button" className="conflict-card-main" onClick={() => onSelect(c)}>
            <div className="conflict-card-top">
              <span className="conflict-env">{c.env_name}</span>
              {c.resolved && <span className="conflict-resolved-tag">Resolved</span>}
              <span className="conflict-days">{c.overlap_days}d</span>
            </div>
            <div className="conflict-when">
              {formatRange(c.start_date, c.end_date)} · {c.peak} projects, room for {c.capacity}
            </div>
            <div className="conflict-projects">
              <ul>
                {c.projects.map((p) => (
                  <li key={p.id}>
                    <span className="priority-tag" data-priority={p.priority}>{p.priority}</span>
                    <span>{p.name}</span>
                  </li>
                ))}
              </ul>
            </div>
          </button>
          {onResolve && (
            <div className="conflict-card-actions">
              <button
                type="button"
                className="btn quiet conflict-resolve"
                onClick={() => onResolve(c, !c.resolved)}
              >
                {c.resolved ? 'Reopen' : 'Mark resolved'}
              </button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}

export function ConflictDrawer({
  conflicts, onSelect, onResolve, onClose,
}: {
  conflicts: Conflict[];
  onSelect: (c: Conflict) => void;
  onResolve?: ResolveHandler;
  onClose: () => void;
}) {
  const unresolved = conflicts.filter((c) => !c.resolved).length;
  const resolved = conflicts.length - unresolved;
  return (
    <aside className="drawer" aria-label="Double-bookings">
      <div className="drawer-head">
        <h2 className="drawer-title">
          {unresolved
            ? `${unresolved} double-booking${unresolved === 1 ? '' : 's'}`
            : 'Double-bookings'}
          {resolved > 0 && <span className="drawer-sub"> · {resolved} resolved</span>}
        </h2>
        <button type="button" className="btn quiet" onClick={onClose}>Close</button>
      </div>
      <ConflictList conflicts={conflicts} onSelect={onSelect} onResolve={onResolve} />
    </aside>
  );
}
