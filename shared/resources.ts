import type { Resource } from './types.ts';

/**
 * The Who column: the people on a task, typed as `Mai, Tuan Nguyen`. The text is
 * only how they are written; what is stored is one `resource` row per person and
 * a `task_resource` row per assignment (reqs/resources.md). Both sides use these
 * rules, so the cell, the files and the server split and match names the same way.
 */

export const RESOURCE_NAME_MAX = 60;
export const RESOURCES_PER_TASK_MAX = 20;

/** Tidy a name as typed: one form of each accent, trimmed, single spaces. */
export function cleanResourceName(name: string): string {
  return name.normalize('NFC').trim().replace(/\s+/g, ' ');
}

/** What two names must share to be the same person: case is ignored, accents are not. */
export function resourceKey(name: string): string {
  return cleanResourceName(name).toLowerCase();
}

export type ParsedResources = { ok: true; names: string[] } | { ok: false; error: string };

/**
 * Split the column into names. Only `,` and `;` separate, so a name can hold
 * spaces. Repeats are dropped, first spelling and order kept. `[` and `]` are
 * refused so MS Project's allocation form (`Mai[50%]`) stays free for later.
 */
export function parseResources(text: string | null | undefined): ParsedResources {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const part of (text ?? '').split(/[,;]/)) {
    const name = cleanResourceName(part);
    if (!name) continue;
    if (/[[\]]/.test(name)) return { ok: false, error: `“${name}”: a name cannot contain [ or ].` };
    if (name.length > RESOURCE_NAME_MAX) return { ok: false, error: `“${name.slice(0, 20)}…” is longer than ${RESOURCE_NAME_MAX} characters.` };
    const key = resourceKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  if (names.length > RESOURCES_PER_TASK_MAX) return { ok: false, error: `A task can have at most ${RESOURCES_PER_TASK_MAX} people.` };
  return { ok: true, names };
}

/** The people on a task back into the column's notation, in the order they were typed. */
export function formatResources(ids: readonly number[] | null | undefined, byId: ReadonlyMap<number, { name: string }>): string {
  return (ids ?? []).map((id) => byId.get(id)?.name).filter((n): n is string => !!n).join(', ');
}

/** The same key with accents taken off, for spotting `Tuấn` typed where `Tuan` exists. */
function looseKey(name: string): string {
  return resourceKey(name).normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd');
}

/** True when `a` becomes `b` by changing, adding or removing one character. */
function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  return a.length > b.length ? a.slice(i + 1) === b.slice(i) : a.slice(i) === b.slice(i + 1);
}

/** A known person a new name is probably a slip for, or null. */
export function nearMatch(name: string, resources: readonly Resource[]): Resource | null {
  const key = resourceKey(name);
  if (!key || resources.some((r) => resourceKey(r.name) === key)) return null;
  const loose = looseKey(name);
  return resources.find((r) => looseKey(r.name) === loose)
    ?? (loose.length >= 3 ? resources.find((r) => oneEditApart(looseKey(r.name), loose)) : undefined)
    ?? null;
}

export type ResourceSuggestion =
  | { kind: 'known'; resource: Resource }
  /** The typed name is new; `near` is a known person it may be a slip for. */
  | { kind: 'new'; name: string; near: Resource | null };

/**
 * What to offer while someone types in Who: known people whose name contains the
 * name under the caret, then the typed name as a new person when nobody has it.
 * `from`/`to` bound the name a pick replaces. People already listed are left out.
 */
export function resourceSuggestions(
  text: string,
  caret: number,
  resources: readonly Resource[],
  limit = 8,
): { from: number; to: number; items: ResourceSuggestion[] } {
  const from = text.slice(0, caret).search(/[^,;]*$/);
  const rest = text.slice(from).match(/^[^,;]*/)![0];
  const lead = rest.match(/^\s*/)![0].length;
  const word = cleanResourceName(rest);
  const listed = new Set(
    (text.slice(0, from) + ',' + text.slice(from + rest.length)).split(/[,;]/).map(resourceKey).filter(Boolean),
  );
  const q = looseKey(word);
  const known = resources
    .filter((r) => r.active !== 0 && !listed.has(resourceKey(r.name)))
    .filter((r) => !q || looseKey(r.name).includes(q))
    .sort((a, b) => (looseKey(a.name).startsWith(q) ? 0 : 1) - (looseKey(b.name).startsWith(q) ? 0 : 1) || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((resource): ResourceSuggestion => ({ kind: 'known', resource }));
  const exists = resources.some((r) => resourceKey(r.name) === resourceKey(word));
  const items = word && !exists
    ? [{ kind: 'new', name: word, near: nearMatch(word, resources) } as ResourceSuggestion, ...known]
    : known;
  // A near match is the likelier meaning, so it goes first.
  const near = items[0]?.kind === 'new' ? items[0].near : null;
  if (near) {
    const at = items.findIndex((s) => s.kind === 'known' && s.resource.id === near.id);
    if (at > 0) items.splice(at, 1);
    if (!listed.has(resourceKey(near.name))) items.unshift({ kind: 'known', resource: near });
  }
  return { from: from + lead, to: from + rest.length, items };
}

/** Put a picked name in place of the one it was chosen for, then `, ` so the next can be typed. */
export function applyResourcePick(text: string, from: number, to: number, name: string): { text: string; caret: number } {
  const before = text.slice(0, from);
  const after = text.slice(to).replace(/^\s*[,;]?\s*/, '');
  const head = before + name + ', ';
  return { text: head + after, caret: head.length };
}
