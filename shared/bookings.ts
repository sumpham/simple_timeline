import type { BookingKind, ISODate } from './types.ts';

/**
 * A one-day booking is an event, not an environment hold, so it is saved as
 * CUSTOM: the kind that carries a marker icon. Releases keep their own kind;
 * they are one day by definition and mean something specific.
 *
 * Both sides call this, so a dialog, a drag and the server agree on the kind a
 * booking will be saved with.
 */
export function effectiveKind(kind: BookingKind, start: ISODate, end: ISODate): BookingKind {
  return start === end && kind !== 'RELEASE' ? 'CUSTOM' : kind;
}
