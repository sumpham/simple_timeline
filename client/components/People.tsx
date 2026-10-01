import type { PersonOverlap } from '../../shared/workload.ts';
import type { Resource } from '../../shared/types.ts';
import { formatRange } from '../layout.ts';

/** One person on this plan, with how much they hold here and elsewhere. */
export type PersonRow = {
  resource: Resource;
  /** Open leaf tasks in this plan, and in other plans. */
  here: number;
  elsewhere: number;
  /** Pairs of their tasks that share a working day; at least one task is in this plan. */
  overlaps: PersonOverlap[];
};

/**
 * Resource status: everyone on this plan, the ones on two tasks at once first.
 * The warning is in ink (a mark, a heavy left rule, the words), never red: red is
 * spent on double-booked environments (DESIGN.md §6).
 */
export function PeoplePanel({ rows, taskLabel, filter, onFilter, onShow, onClose }: {
  rows: readonly PersonRow[];
  /** How to name a task: its ID and name here, or its name and project elsewhere. */
  taskLabel: (id: number) => string;
  filter: number | null;
  onFilter: (id: number | null) => void;
  /** Bring this plan's tasks into view and mark them. */
  onShow: (ids: number[]) => void;
  onClose: () => void;
}) {
  const clashing = rows.filter((r) => r.overlaps.length).length;
  return (
    <section className="people-panel" aria-label="Resource status">
      <header className="people-head">
        <h3 className="people-title">Resource status</h3>
        <span className="people-sub">
          {!rows.length ? 'Nobody is on this plan yet. Type names in the Who column.'
            : clashing ? `${clashing} of ${rows.length} ${rows.length === 1 ? 'person is' : 'people are'} on tasks that overlap`
              : `${rows.length} ${rows.length === 1 ? 'person' : 'people'}, no overlapping tasks`}
        </span>
        <span className="spacer" />
        {filter != null && <button type="button" className="btn quiet" onClick={() => onFilter(null)}>Show everyone’s tasks</button>}
        <button type="button" className="btn quiet" onClick={onClose} aria-label="Close resource status">Close</button>
      </header>
      {rows.length > 0 && (
        <ul className="people-list">
          {rows.map(({ resource: r, here, elsewhere, overlaps }) => (
            <li key={r.id} className="people-row" data-overlap={overlaps.length > 0 || undefined} data-picked={filter === r.id || undefined}>
              <div className="people-line">
                {overlaps.length > 0 && <span className="people-mark" aria-hidden="true">▲</span>}
                <strong className="people-name">{r.name}</strong>
                {r.active === 0 && <span className="people-meta">inactive</span>}
                <span className="people-meta">
                  {here} task{here === 1 ? '' : 's'} here{elsewhere ? `, ${elsewhere} in other plans` : ''}
                </span>
                <span className="people-meta people-state">
                  {overlaps.length ? `${overlaps.length} overlap${overlaps.length === 1 ? '' : 's'}` : 'OK'}
                </span>
                <span className="spacer" />
                <button
                  type="button"
                  className="btn quiet"
                  aria-pressed={filter === r.id}
                  onClick={() => onFilter(filter === r.id ? null : r.id)}
                  title={`Show only the tasks ${r.name} is on`}
                >
                  {filter === r.id ? 'Showing their tasks' : 'Their tasks'}
                </button>
              </div>
              {overlaps.length > 0 && (
                <ul className="people-overlaps">
                  {overlaps.map((o) => (
                    <li key={`${o.a}-${o.b}`}>
                      <span>{taskLabel(o.a)}</span>
                      <span className="people-and"> and </span>
                      <span>{taskLabel(o.b)}</span>
                      <span className="people-meta"> · {formatRange(o.start, o.end)}, {o.days} working day{o.days === 1 ? '' : 's'}</span>
                      <button type="button" className="link-button" onClick={() => onShow([o.a, o.b])}>Show</button>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
