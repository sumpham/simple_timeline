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

/**
 * What a bar says when nobody has written its timeline text: the project name,
 * then the note. Kept as a function rather than stored, so renaming a project or
 * editing a note still flows through to every bar that has not been customised.
 */
export function defaultTimelineText(projectName: string, note: string | null | undefined): string {
  const flat = (note ?? '').replace(/\s+/g, ' ').trim();
  return flat ? `${projectName} · ${flat}` : projectName;
}

/**
 * The timeline text to store from what the form holds: null when it is blank or
 * still the default, so an untouched booking keeps following its project and note.
 */
export function timelineTextToStore(text: string | null | undefined, defaultText: string): string | null {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  return !flat || flat === defaultText ? null : flat;
}
