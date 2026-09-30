import { addDays, addWorkingDays, snapToWorkingDay, workingDays, type HolidaySet } from '../dates.ts';
import type { ISODate } from '../types.ts';
import type { PlanFacts, TaskFacts } from './facts.ts';
import type { Finding } from './rules.ts';

/**
 * The plan as an LLM reads it (reqs/smart_assistant.md §6.2): facts, not rows;
 * pruned to what can hurt; one compact line per task; dates as working-day
 * offsets from the status date, so the model never does calendar arithmetic and
 * short numbers cost fewer tokens. People and other projects can be pseudonymised
 * and notes left out; `unmask` maps the names back in the answer.
 *
 * Two parts, so a provider can cache the first: `network` changes only when
 * tasks or links do; `state` changes with progress and the date.
 */

export type DigestLevel = 0 | 1 | 2 | 3;

export type DigestOptions = {
  level: DigestLevel;
  sendPeople: boolean;
  sendOtherProjects: boolean;
  sendNotes: boolean;
};

export type DigestInput = {
  facts: PlanFacts;
  findings: readonly Finding[];
  /** Notes by task id, sent only when allowed and only for flagged tasks. */
  notes: ReadonlyMap<number, string | null>;
  /** People's names by resource id. */
  people: ReadonlyMap<number, string>;
  /** The team's environment names by id. */
  environments: ReadonlyMap<number, string>;
  /** Top-level summary of each task, for collapsing what is left out. */
  branchOf: ReadonlyMap<number, number | null>;
};

export type Digest = {
  level: DigestLevel;
  network: string;
  state: string;
  /** Pseudonym → real name, for people (R1) and other projects (O1); O, not P, so they never read as rule P1. */
  unmask: Map<string, string>;
  shown: number;
  total: number;
};

export const NAME_MAX = 40;
export const NOTE_MAX = 160;

/** Working days from the status date to `d`: 0 on the status date, negative before it. */
export function offsetOf(statusDate: ISODate, d: ISODate, holidays?: HolidaySet): number {
  const base = snapToWorkingDay(statusDate, holidays);
  if (d >= base) return workingDays(base, d, holidays) - 1;
  return -workingDays(d, addDays(base, -1), holidays);
}

/** The working day at an offset from the status date; the inverse of offsetOf on working days. */
export function dateAtOffset(statusDate: ISODate, offset: number, holidays?: HolidaySet): ISODate {
  return addWorkingDays(snapToWorkingDay(statusDate, holidays), offset, holidays);
}

const sign = (n: number) => (n >= 0 ? `+${n}` : String(n));
const STATUS: Record<string, string> = { todo: 't', in_progress: 'p', blocked: 'b', done: 'd' };
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/[|\n\r]+/g, ' ');

/** Which tasks each level keeps: from the whole risky part of the plan down to the critical path alone. */
function kept(f: PlanFacts, findings: readonly Finding[], level: DigestLevel): Set<number> {
  const open = f.tasks.filter((t) => !t.summary && t.status !== 'done');
  const flagged = new Set(findings.filter((x) => !x.dismissed && (level < 2 || x.group !== 'hygiene')).flatMap((x) => x.task_ids));
  const clash = new Set(f.clashes.flatMap((c) => c.task_ids));
  const keep = new Set<number>();
  for (const t of open) {
    if (t.critical) keep.add(t.id);
    else if (level <= 2 && flagged.has(t.id)) keep.add(t.id);
    else if (level === 0 && (t.near_critical || clash.has(t.id))) keep.add(t.id);
  }
  if (level === 0) {
    for (const id of [...keep]) for (const p of f.byId.get(id)!.preds) if (f.byId.get(p)?.status !== 'done') keep.add(p);
  }
  return keep;
}

export function buildDigest(input: DigestInput, opts: DigestOptions): Digest {
  const f = input.facts;
  const off = (d: ISODate) => sign(offsetOf(f.status_date, d, f.holidays));
  const unmask = new Map<string, string>();
  const personAlias = new Map<number, string>();
  const person = (id: number) => {
    const name = input.people.get(id) ?? `#${id}`;
    if (opts.sendPeople) return clip(name, NAME_MAX);
    if (!personAlias.has(id)) {
      const alias = `R${personAlias.size + 1}`;
      personAlias.set(id, alias);
      unmask.set(alias, name);
    }
    return personAlias.get(id)!;
  };
  const projectAlias = new Map<number, string>();
  const project = (p: { id: number; name: string; priority: string }) => {
    if (opts.sendOtherProjects) return `"${clip(p.name, NAME_MAX)}"(${p.priority})`;
    if (!projectAlias.has(p.id)) {
      const alias = `O${projectAlias.size + 1}`;
      projectAlias.set(p.id, alias);
      unmask.set(alias, p.name);
    }
    return `${projectAlias.get(p.id)}(${p.priority})`;
  };
  const code = (id: number) => String(f.byId.get(id)?.code ?? `#${id}`);

  const keep = kept(f, input.findings, opts.level);
  const working = f.tasks.filter((t) => !t.summary);
  const rows = working.filter((t) => keep.has(t.id));

  // ---- network: what changes only when tasks or links do
  const net: string[] = [
    `PROJ "${clip(f.project.name, NAME_MAX)}" priority=${f.project.priority}`,
    'T code|name|dur|best-worst|env|after',
  ];
  for (const t of rows) {
    const after = f.links.filter((d) => d.successor_id === t.id)
      .map((d) => `${code(d.predecessor_id)}${(d.type ?? 'FS') === 'FS' ? '' : d.type}${d.lag ? sign(d.lag) : ''}`).join(',');
    net.push([
      code(t.id), clip(t.name, NAME_MAX), t.duration, rangeText(t),
      t.environment_id != null ? input.environments.get(t.environment_id) ?? '' : '', after,
    ].join('|'));
  }
  // What was left out, one line per top-level branch, so the model knows it exists.
  const left = new Map<number | null, TaskFacts[]>();
  for (const t of working) {
    if (keep.has(t.id)) continue;
    const b = input.branchOf.get(t.id) ?? null;
    (left.get(b) ?? left.set(b, []).get(b)!).push(t);
  }
  for (const [b, ts] of left) {
    const done = ts.filter((t) => t.status === 'done').length;
    const openTs = ts.filter((t) => t.status !== 'done');
    const minTf = openTs.length ? Math.min(...openTs.map((t) => t.total_float)) : null;
    const name = b != null ? `"${clip(f.byId.get(b)?.name ?? '', NAME_MAX)}"` : 'top level';
    net.push(`~ ${name}: ${ts.length} tasks not shown, ${done} done${minTf != null ? `, min float ${minTf}` : ''}`);
  }

  // ---- state: progress, dates, risks
  const fc = f.forecast;
  const st: string[] = [
    `STATUS date=${f.status_date} (offsets below are working days from it)`
      + ` finish=${f.finish ? off(f.finish) : '-'}`
      + (f.project.target_date ? ` target=${off(f.project.target_date)} late=${f.late_by}` : ' target=none')
      + (fc ? ` p50=${off(fc.p50)} p80=${off(fc.p80)}${fc.on_time != null ? ` onTime=${Math.round(fc.on_time * 100)}%` : ''}` : ''),
    `CP ${f.critical_path.filter((id) => keep.has(id)).map(code).join('>')}`,
    'S code|st|prog|start|end|tf|pace|who|flags',
  ];
  const flagged = new Map<number, string[]>();
  for (const x of input.findings) if (!x.dismissed) for (const id of x.task_ids) (flagged.get(id) ?? flagged.set(id, []).get(id)!).push(x.rule);
  for (const t of rows) {
    const flags = [t.critical ? 'C' : t.near_critical ? 'N' : '', t.preds.length >= 3 ? 'M' : '', ...(flagged.get(t.id) ?? [])].filter(Boolean);
    st.push([
      code(t.id), STATUS[t.status], t.progress ?? '', off(t.start), off(t.end), t.total_float,
      t.spi != null ? t.spi.toFixed(2) : '', t.people.map(person).join(','), flags.join(','),
    ].join('|'));
  }
  for (const c of f.clashes) {
    st.push(`X ${c.conflict.env_name} ${off(c.conflict.start_date)}..${off(c.conflict.end_date)} cap${c.conflict.capacity} peak${c.conflict.peak}`
      + ` with ${c.others.map(project).join(',')} tasks=${c.task_ids.map(code).join(',')}`);
  }
  if (fc) {
    const often = fc.criticality.filter((x) => x.index >= 0.3).map((x) => `${code(x.id)}:${Math.round(x.index * 100)}%`);
    if (often.length) st.push(`CI ${often.join(' ')}`);
    if (fc.sensitivity.length) st.push(`SENS ${fc.sensitivity.slice(0, 5).map((x) => `${code(x.id)}:${x.correlation}`).join(' ')}`);
  }
  for (const x of input.findings) {
    if (x.dismissed || (opts.level >= 2 && x.group === 'hygiene') || (opts.level === 3 && x.group !== 'progress')) continue;
    st.push(`F ${x.key} L${x.likelihood} I${x.impact} ${x.task_ids.map(code).join(',')} "${clip(x.title, 60)}"`);
  }
  if (opts.sendNotes && opts.level < 2) {
    for (const t of rows) {
      const note = input.notes.get(t.id);
      if (note && flagged.has(t.id)) st.push(`N ${code(t.id)} "${clip(note, NOTE_MAX)}"`);
    }
  }

  return { level: opts.level, network: net.join('\n'), state: st.join('\n'), unmask, shown: rows.length, total: working.length };
}

/** `4-9` for a typed range, `~` when the forecast uses its default. */
function rangeText(t: TaskFacts): string {
  return t.best == null && t.worst == null ? '~' : `${t.best ?? '~'}-${t.worst ?? '~'}`;
}

/** Replace pseudonyms (R1, O2) in the model's text with the names they stand for. */
export function unmaskText(text: string, unmask: ReadonlyMap<string, string>): string {
  if (!unmask.size) return text;
  return text.replace(/\b([RO]\d+)\b/g, (m) => unmask.get(m) ?? m);
}

