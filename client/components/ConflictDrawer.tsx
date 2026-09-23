import type { Conflict } from '../../shared/types.ts';
import { formatRange } from '../layout.ts';

/** Shared by the desktop drawer and the phone's pull-up sheet. */
export function ConflictList({ conflicts, onSelect }: { conflicts: Conflict[]; onSelect: (c: Conflict) => void }) {
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
        <button
          key={`${c.environment_id}-${c.start_date}`}
          type="button"
          className="conflict-card"
          onClick={() => onSelect(c)}
        >
          <div className="conflict-card-top">
            <span className="conflict-env">{c.env_name}</span>
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
      ))}
    </>
  );
}

export function ConflictDrawer({
  conflicts, onSelect, onClose,
}: {
  conflicts: Conflict[];
  onSelect: (c: Conflict) => void;
  onClose: () => void;
}) {
  return (
    <aside className="drawer" aria-label="Double-bookings">
      <div className="drawer-head">
        <h2 className="drawer-title">
          {conflicts.length
            ? `${conflicts.length} double-booking${conflicts.length === 1 ? '' : 's'}`
            : 'Double-bookings'}
        </h2>
        <button type="button" className="btn quiet" onClick={onClose}>Close</button>
      </div>
      <ConflictList conflicts={conflicts} onSelect={onSelect} />
    </aside>
  );
}
