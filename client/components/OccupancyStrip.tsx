import type { CSSProperties } from 'react';
import { nextBookingAfter, occupancyOn } from '../../shared/conflicts.ts';
import type { BookingView, Environment, ISODate } from '../../shared/types.ts';
import { formatDate, relativeDays } from '../layout.ts';
import { ENV_COLOR } from './Board.tsx';

/**
 * The lead's first question on opening the tool is "who holds SIT right now,
 * and who is next" -- not "how many problems do I have". This answers that,
 * and is why there is no conflict-count hero tile.
 */
export function OccupancyStrip({
  environments, bookings, today,
}: {
  environments: Environment[];
  bookings: BookingView[];
  today: ISODate;
}) {
  if (!environments.length) return null;

  return (
    <div className="strip">
      <div className="strip-label">Today</div>
      {environments.map((env) => {
        const holders = occupancyOn(bookings, env.id, today);
        const next = nextBookingAfter(bookings, env.id, today);
        const over = holders.length > env.capacity;

        return (
          <div
            key={env.id}
            className="strip-cell"
            style={{ '--env-color': ENV_COLOR[env.kind] } as CSSProperties}
          >
            <div className="strip-env">{env.name}</div>
            <div className={`strip-holder${over ? ' clash' : holders.length ? '' : ' free'}`}>
              {holders.length === 0 && 'Free'}
              {holders.length === 1 && holders[0].project_name}
              {holders.length > 1 && (over
                ? `${holders.length} projects, room for ${env.capacity}`
                : `${holders.length} of ${env.capacity} booked`)}
            </div>
            <div className="strip-next">
              {holders.length === 1
                ? `until ${formatDate(holders[0].end_date)}, ${relativeDays(today, holders[0].end_date)}`
                : holders.length > 1
                  ? holders.map((h) => h.project_name).join(', ')
                  : next
                    ? `next ${next.project_name}, ${formatDate(next.start_date)}`
                    : 'nothing booked'}
            </div>
          </div>
        );
      })}
    </div>
  );
}
