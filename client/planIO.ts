import type { Environment, LinkType, Resource, Task, TaskDependency, TaskSchedule, TaskStatus } from '../shared/types.ts';
import { formatResources } from '../shared/resources.ts';
import type { OutlineRow } from '../shared/wbs.ts';
import { formatPredecessors, parsePredecessors } from './predecessors.ts';
import { codesById } from '../shared/taskCode.ts';
import { estimateError } from '../shared/estimates.ts';

/**
 * A plan in and out of files: CSV for spreadsheets, and MS Project's XML
 * (MSPDI) for the tool most IT plans already live in. Pure, so both directions
 * are tested; the browser only reads and saves the files.
 *
 * An import is a list of rows that refer to each other by position (1-based):
 * `parent` names a row above, `predecessors` any other row. The server checks
 * them with the same outline and link rules as a hand edit.
 */

export type ImportRow = {
  /** The file's TaskID, kept when it is free in the plan. */
  code?: number | null;
  name: string;
  duration: number;
  environment?: string | null;
  parent?: number | null;
  predecessors: { row: number; lag: number; type: LinkType }[];
  /** Who does it, in the Who column's notation (`Mai, Tuan`); the server makes new people. */
  resources?: string | null;
  status?: TaskStatus;
  progress?: number | null;
  not_before?: string | null;
  /** Finish by this date (shared/schedule.ts): never moves the task, uses up its float. */
  deadline?: string | null;
  note?: string | null;
  /** Best and worst case in working days, for the forecast (shared/estimates.ts). */
  duration_low?: number | null;
  duration_high?: number | null;
  /** MS Project's saved baselines for this task, by number (0 is "Baseline", n is "Baseline n"). */
  baselines?: { number: number; start: string; finish: string; duration: number | null }[];
};

/** A plan's baselines for a file, oldest first: each written as MS Project's Baseline 0, 1, 2… */
export type FileBaseline = { name: string; rows: ReadonlyMap<number, { start: string; end: string; duration: number | null }> };

/** The name a baseline number reads as, the way MS Project lists them. */
export function baselineNameOf(number: number): string {
  return number === 0 ? 'Baseline' : `Baseline ${number}`;
}

export type ImportResult = { ok: true; rows: ImportRow[]; warnings: string[] } | { ok: false; error: string };

type Plan = {
  tasks: readonly Task[];
  outline: readonly OutlineRow[];
  schedule: ReadonlyMap<number, TaskSchedule>;
  deps: readonly TaskDependency[];
  environments: readonly Environment[];
  /** Everyone the tasks' `resource_ids` may name. */
  resources?: readonly Resource[];
};

const STATUS_WORDS: Record<TaskStatus, string> = { todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done' };

// ---------------------------------------------------------------- CSV

const CSV_HEAD = ['ID', 'WBS', 'Task', 'Summary', 'Environment', 'Days', 'Best', 'Worst', 'After', 'Start', 'Finish', 'Deadline', 'Float', 'Status', 'Progress', 'Resources', 'Note'];

function csvCell(v: string | number | null | undefined): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** The table as a spreadsheet: TaskIDs and After exactly as the table shows them. */
export function toCsv(plan: Plan): string {
  const rowOf = codesById(plan.tasks);
  const byId = new Map(plan.outline.map((r) => [r.id, r]));
  const people = new Map((plan.resources ?? []).map((r) => [r.id, r]));
  const lines = [CSV_HEAD.join(',')];
  for (const t of plan.tasks) {
    const o = byId.get(t.id);
    const s = plan.schedule.get(t.id);
    lines.push([
      rowOf.get(t.id), o?.wbs, t.name, o?.parent_id != null ? rowOf.get(o.parent_id) : '',
      plan.environments.find((e) => e.id === t.environment_id)?.name ?? '',
      o?.summary ? '' : t.duration, o?.summary ? '' : t.duration_low, o?.summary ? '' : t.duration_high,
      formatPredecessors(plan.deps, t.id, rowOf),
      s?.start, s?.end, t.deadline ?? '', s ? s.total_float : '', STATUS_WORDS[t.status], t.progress ?? '', formatResources(t.resource_ids, people), t.note,
    ].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** RFC 4180: quoted fields, doubled quotes, newlines inside quotes. */
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

const ALIASES: Record<string, string[]> = {
  row: ['row', '#', 'id'],
  wbs: ['wbs', 'outline', 'outline number'],
  name: ['task', 'name', 'task name', 'title'],
  parent: ['summary', 'parent', 'summary row', 'parent row'],
  environment: ['environment', 'env'],
  duration: ['days', 'duration', 'working days'],
  duration_low: ['best', 'best case', 'optimistic', 'optimistic duration'],
  duration_high: ['worst', 'worst case', 'pessimistic', 'pessimistic duration'],
  after: ['after', 'predecessors', 'depends on'],
  status: ['status'],
  progress: ['progress', '% complete', 'percent complete', '%'],
  not_before: ['start no earlier than', 'not before', 'snet'],
  deadline: ['deadline', 'due', 'due date', 'finish by'],
  resources: ['resources', 'who', 'assignee', 'assigned to', 'owner', 'resource', 'resource names'],
  note: ['note', 'notes'],
};

function statusFrom(v: string): TaskStatus | undefined {
  const s = v.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!s) return undefined;
  if (s === 'todo' || s === 'notstarted' || s === 'open') return 'todo';
  if (s === 'inprogress' || s === 'started' || s === 'doing') return 'in_progress';
  if (s === 'blocked' || s === 'onhold') return 'blocked';
  if (s === 'done' || s === 'complete' || s === 'completed' || s === 'closed') return 'done';
  return undefined;
}

export function fromCsv(text: string): ImportResult {
  const table = parseCsvText(text);
  if (table.length < 2) return { ok: false, error: 'The file needs a header row and at least one task.' };
  const head = table[0].map((h) => h.trim().toLowerCase());
  const col = (key: string) => head.findIndex((h) => ALIASES[key].includes(h));
  const at = Object.fromEntries(Object.keys(ALIASES).map((k) => [k, col(k)])) as Record<string, number>;
  if (at.name < 0) return { ok: false, error: 'No task name column. Name one "Task" or "Name".' };

  const body = table.slice(1);
  const cell = (r: string[], key: string) => (at[key] >= 0 ? (r[at[key]] ?? '').trim() : '');
  // The file's own row numbers, when it has them, are what After and Summary refer to.
  const fileRow = new Map<string, number>();
  body.forEach((r, i) => fileRow.set(cell(r, 'row') || String(i + 1), i + 1));
  const wbsRow = new Map<string, number>();
  body.forEach((r, i) => { if (cell(r, 'wbs')) wbsRow.set(cell(r, 'wbs'), i + 1); });

  const warnings: string[] = [];
  const rows: ImportRow[] = [];
  for (let i = 0; i < body.length; i++) {
    const r = body[i];
    const n = i + 1;
    const name = cell(r, 'name');
    if (!name) return { ok: false, error: `Row ${n} has no task name.` };
    const dText = cell(r, 'duration').replace(/\s*(d|days?)$/i, '');
    const duration = dText ? Number(dText) : 1;
    if (!Number.isInteger(duration) || duration < 0) return { ok: false, error: `Row ${n}: “${cell(r, 'duration')}” is not a whole number of days.` };

    const range: Pick<ImportRow, 'duration_low' | 'duration_high'> = {};
    for (const k of ['duration_low', 'duration_high'] as const) {
      const v = cell(r, k).replace(/\s*(d|days?)$/i, '');
      if (!v) continue;
      const x = Number(v);
      if (!Number.isInteger(x) || x < 0) return { ok: false, error: `Row ${n}: “${cell(r, k)}” is not a whole number of days.` };
      range[k] = x;
    }
    const rangeProblem = estimateError(duration, range.duration_low, range.duration_high);
    if (rangeProblem) return { ok: false, error: `Row ${n}: ${rangeProblem}.` };

    let parent: number | null = null;
    if (cell(r, 'parent')) {
      parent = fileRow.get(cell(r, 'parent')) ?? null;
      if (parent == null) return { ok: false, error: `Row ${n}: there is no row ${cell(r, 'parent')} for its summary.` };
    } else if (cell(r, 'wbs').includes('.')) {
      parent = wbsRow.get(cell(r, 'wbs').replace(/\.[^.]*$/, '')) ?? null;
    }
    if (parent != null && parent >= n) return { ok: false, error: `Row ${n}: its summary must be a row above it.` };

    // After refers to the file's row numbers; translate them to positions.
    const afterText = cell(r, 'after').replace(/\d+/g, (m, off, str) => {
      const prev = str[off - 1];
      return prev === '+' || prev === '-' ? m : String(fileRow.get(m) ?? m);
    });
    const parsed = parsePredecessors(afterText, body.length, n);
    if (!parsed.ok) return { ok: false, error: `Row ${n}: ${parsed.error}` };

    const pText = cell(r, 'progress').replace('%', '');
    const progress = pText ? Math.round(Number(pText)) : null;
    if (progress != null && !(progress >= 0 && progress <= 100)) return { ok: false, error: `Row ${n}: progress is 0 to 100.` };
    const status = statusFrom(cell(r, 'status'));
    if (cell(r, 'status') && !status) warnings.push(`Row ${n}: status “${cell(r, 'status')}” was not understood, so it is To do`);
    const nb = cell(r, 'not_before');
    const dl = cell(r, 'deadline');
    const code = Number(cell(r, 'row'));
    rows.push({
      code: Number.isInteger(code) && code > 0 ? code : null,
      name, duration, parent, predecessors: parsed.rows,
      environment: cell(r, 'environment') || null,
      resources: cell(r, 'resources') || null,
      status: status ?? 'todo',
      progress,
      not_before: /^\d{4}-\d{2}-\d{2}$/.test(nb) ? nb : null,
      deadline: /^\d{4}-\d{2}-\d{2}$/.test(dl) ? dl : null,
      note: cell(r, 'note') || null,
      ...range,
    });
    if (nb && !/^\d{4}-\d{2}-\d{2}$/.test(nb)) warnings.push(`Row ${n}: “${nb}” is not a YYYY-MM-DD date, so it was left out`);
    if (dl && !/^\d{4}-\d{2}-\d{2}$/.test(dl)) warnings.push(`Row ${n}: deadline “${dl}” is not a YYYY-MM-DD date, so it was left out`);
  }
  return { ok: true, rows, warnings };
}

// ---------------------------------------------------------------- MS Project XML

const MSP_TYPE: Record<LinkType, number> = { FF: 0, FS: 1, SS: 3 };
/** MS Project stores lag in tenths of a minute; a working day is eight hours. */
const TENTHS_PER_DAY = 8 * 60 * 10;
/**
 * Best and worst case ride in MS Project's custom Duration1 and Duration3, the
 * fields its PERT analysis uses for optimistic and pessimistic durations.
 */
const FIELD_BEST = '188743783';
const FIELD_WORST = '188743785';
const hoursOf = (days: number) => `PT${days * 8}H0M0S`;

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

/** MSPDI, the XML MS Project opens and saves: tasks, outline, links, progress, and who does what. */
export function toMspdi(plan: Plan & { projectName: string; projectStart: string | null; baselines?: readonly FileBaseline[] }): string {
  const rowOf = new Map(plan.tasks.map((t, i) => [t.id, i + 1]));
  const byId = new Map(plan.outline.map((r) => [r.id, r]));
  const tag = (name: string, v: string | number) => `<${name}>${typeof v === 'string' ? esc(v) : v}</${name}>`;
  const out: string[] = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    '<Project xmlns="http://schemas.microsoft.com/project">',
    tag('Name', plan.projectName),
    tag('Title', plan.projectName),
    ...(plan.projectStart ? [tag('StartDate', `${plan.projectStart}T08:00:00`)] : []),
    tag('ScheduleFromStart', 1),
    tag('MinutesPerDay', 480),
    ...(plan.tasks.some((t) => t.duration_low != null || t.duration_high != null) ? [
      '<ExtendedAttributes>',
      '<ExtendedAttribute>', tag('FieldID', FIELD_BEST), tag('FieldName', 'Duration1'), tag('Alias', 'Best'), '</ExtendedAttribute>',
      '<ExtendedAttribute>', tag('FieldID', FIELD_WORST), tag('FieldName', 'Duration3'), tag('Alias', 'Worst'), '</ExtendedAttribute>',
      '</ExtendedAttributes>',
    ] : []),
    '<Tasks>',
  ];
  for (const t of plan.tasks) {
    const o = byId.get(t.id);
    const s = plan.schedule.get(t.id);
    const row = rowOf.get(t.id)!;
    const summary = !!o?.summary;
    const days = summary ? 0 : t.duration;
    out.push('<Task>',
      tag('UID', row), tag('ID', row), tag('Name', t.name),
      tag('OutlineNumber', o?.wbs ?? String(row)), tag('OutlineLevel', (o?.depth ?? 0) + 1),
      tag('Summary', summary ? 1 : 0), tag('Milestone', !summary && t.duration === 0 ? 1 : 0),
      ...(s ? [tag('Start', `${s.start}T08:00:00`), tag('Finish', `${s.end}T17:00:00`)] : []),
      ...(summary ? [] : [tag('Duration', `PT${days * 8}H0M0S`), tag('DurationFormat', 7)]),
      tag('PercentComplete', t.progress ?? (t.status === 'done' ? 100 : 0)),
      ...(t.not_before ? [tag('ConstraintType', 4), tag('ConstraintDate', `${t.not_before}T08:00:00`)] : []),
      ...(t.deadline ? [tag('Deadline', `${t.deadline}T17:00:00`)] : []),
      ...(t.note ? [tag('Notes', t.note)] : []),
      ...(!summary ? ([[FIELD_BEST, t.duration_low], [FIELD_WORST, t.duration_high]] as const).flatMap(([field, v]) => (v == null ? [] : [
        '<ExtendedAttribute>', tag('FieldID', field), tag('Value', hoursOf(v)), tag('DurationFormat', 7), '</ExtendedAttribute>',
      ])) : []),
      // Up to eleven baselines, numbered as MS Project numbers them; names do not survive the trip.
      ...(plan.baselines ?? []).slice(0, 11).flatMap((b, n) => {
        const r = b.rows.get(t.id);
        return r ? [
          '<Baseline>', tag('Number', n), tag('Start', `${r.start}T08:00:00`), tag('Finish', `${r.end}T17:00:00`),
          ...(r.duration != null && !summary ? [tag('Duration', hoursOf(r.duration)), tag('DurationFormat', 7)] : []),
          '</Baseline>',
        ] : [];
      }));
    for (const d of plan.deps.filter((x) => x.successor_id === t.id && rowOf.has(x.predecessor_id))) {
      out.push('<PredecessorLink>',
        tag('PredecessorUID', rowOf.get(d.predecessor_id)!), tag('Type', MSP_TYPE[d.type ?? 'FS'] ?? 1),
        tag('LinkLag', d.lag * TENTHS_PER_DAY), tag('LagFormat', 7),
        '</PredecessorLink>');
    }
    out.push('</Task>');
  }
  out.push('</Tasks>');
  // People as MS Project keeps them: a resource list, then one assignment per task and person.
  const people = new Map((plan.resources ?? []).map((r) => [r.id, r]));
  const used = [...new Set(plan.tasks.flatMap((t) => t.resource_ids ?? []))].filter((id) => people.has(id));
  if (used.length) {
    const uidOf = new Map(used.map((id, i) => [id, i + 1]));
    out.push('<Resources>');
    for (const id of used) out.push('<Resource>', tag('UID', uidOf.get(id)!), tag('ID', uidOf.get(id)!), tag('Name', people.get(id)!.name), tag('Type', 1), '</Resource>');
    out.push('</Resources>', '<Assignments>');
    let uid = 1;
    for (const t of plan.tasks) {
      for (const id of t.resource_ids ?? []) {
        if (!uidOf.has(id)) continue;
        out.push('<Assignment>', tag('UID', uid++), tag('TaskUID', rowOf.get(t.id)!), tag('ResourceUID', uidOf.get(id)!), tag('Units', 1), '</Assignment>');
      }
    }
    out.push('</Assignments>');
  }
  out.push('</Project>');
  return `${out.join('\n')}\n`;
}

const first = (xml: string, name: string) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? unesc(m[1].trim()) : null;
};

/** Read MSPDI. Summary rows become summaries by outline level; SF links are not supported and become FS. */
export function fromMspdi(xml: string): ImportResult {
  const tasksBlock = /<Tasks>([\s\S]*)<\/Tasks>/.exec(xml)?.[1];
  if (!tasksBlock) return { ok: false, error: 'That is not an MS Project XML file: it has no tasks.' };
  const tasksAll = [...tasksBlock.matchAll(/<Task>([\s\S]*?)<\/Task>/g)].map((m) => m[1]);
  // A task's baselines carry their own Start, Finish and Duration; read them apart so they never pass for the task's.
  const savedOf = tasksAll.map((b) => [...b.matchAll(/<Baseline>([\s\S]*?)<\/Baseline>/g)].map((m) => m[1]));
  const blocks = tasksAll.map((b) => b.replace(/<Baseline>[\s\S]*?<\/Baseline>/g, ''));
  const warnings: string[] = [];
  type Raw = {
    uid: string; name: string; level: number; hours: number; progress: number | null; links: { uid: string; type: number; lag: number }[];
    note: string | null; nb: string | null; deadline: string | null; best: number | null; worst: number | null;
    baselines: NonNullable<ImportRow['baselines']>;
  };
  const raws: Raw[] = [];
  for (const [bi, b] of blocks.entries()) {
    const uid = first(b, 'UID') ?? '';
    const level = Number(first(b, 'OutlineLevel') ?? '1');
    // UID 0 / level 0 is the project's own summary row, not a task.
    if (uid === '0' || level === 0 || first(b, 'IsNull') === '1') continue;
    const name = first(b.replace(/<PredecessorLink>[\s\S]*?<\/PredecessorLink>/g, ''), 'Name');
    if (!name) continue;
    const dur = /PT(\d+(?:\.\d+)?)H(\d+)M/.exec(first(b, 'Duration') ?? '');
    const links = [...b.matchAll(/<PredecessorLink>([\s\S]*?)<\/PredecessorLink>/g)].map((m) => ({
      uid: first(m[1], 'PredecessorUID') ?? '',
      type: Number(first(m[1], 'Type') ?? '1'),
      lag: Number(first(m[1], 'LinkLag') ?? '0'),
    }));
    const pc = first(b, 'PercentComplete');
    const attrs = new Map([...b.matchAll(/<ExtendedAttribute>([\s\S]*?)<\/ExtendedAttribute>/g)]
      .map((m) => [first(m[1], 'FieldID') ?? '', first(m[1], 'Value') ?? '']));
    const daysOf = (v: string | undefined) => {
      const m = /PT(\d+(?:\.\d+)?)H(\d+)M/.exec(v ?? '');
      return m ? Math.max(0, Math.round((Number(m[1]) + Number(m[2]) / 60) / 8)) : null;
    };
    const ct = first(b, 'ConstraintType');
    const cd = first(b, 'ConstraintDate');
    raws.push({
      uid, name, level,
      hours: dur ? Number(dur[1]) + Number(dur[2]) / 60 : 8,
      progress: pc != null ? Math.max(0, Math.min(100, Math.round(Number(pc)))) : null,
      links, note: first(b, 'Notes'),
      nb: (ct === '4' || ct === '2') && cd ? cd.slice(0, 10) : null,
      deadline: /^\d{4}-\d{2}-\d{2}/.test(first(b, 'Deadline') ?? '') ? first(b, 'Deadline')!.slice(0, 10) : null,
      best: daysOf(attrs.get(FIELD_BEST)),
      worst: daysOf(attrs.get(FIELD_WORST)),
      baselines: savedOf[bi].flatMap((s) => {
        const number = Number(first(s, 'Number') ?? '0');
        const start = (first(s, 'Start') ?? '').slice(0, 10);
        const finish = (first(s, 'Finish') ?? '').slice(0, 10);
        if (!Number.isInteger(number) || number < 0 || number > 10 || !/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(finish)) return [];
        return [{ number, start, finish, duration: daysOf(first(s, 'Duration') ?? undefined) }];
      }),
    });
  }
  if (!raws.length) return { ok: false, error: 'That MS Project file has no tasks.' };

  // Who does what: the resource list by UID, then each assignment onto its task.
  const nameOfResource = new Map<string, string>();
  for (const m of (/<Resources>([\s\S]*?)<\/Resources>/.exec(xml)?.[1] ?? '').matchAll(/<Resource>([\s\S]*?)<\/Resource>/g)) {
    const uid = first(m[1], 'UID');
    const name = first(m[1], 'Name');
    if (uid && uid !== '0' && name) nameOfResource.set(uid, name.replace(/[,;[\]]/g, ' '));
  }
  const whoOfTask = new Map<string, string[]>();
  for (const m of (/<Assignments>([\s\S]*?)<\/Assignments>/.exec(xml)?.[1] ?? '').matchAll(/<Assignment>([\s\S]*?)<\/Assignment>/g)) {
    const task = first(m[1], 'TaskUID');
    const name = nameOfResource.get(first(m[1], 'ResourceUID') ?? '');
    if (!task || !name) continue;
    if (!whoOfTask.has(task)) whoOfTask.set(task, []);
    whoOfTask.get(task)!.push(name);
  }

  const rowOfUid = new Map(raws.map((r, i) => [r.uid, i + 1]));
  const stack: number[] = [];
  const rows: ImportRow[] = raws.map((r, i) => {
    stack.length = Math.max(0, r.level - 1);
    const parent = stack.length ? stack[stack.length - 1] : null;
    stack[r.level - 1] = i + 1;
    const predecessors = r.links.flatMap((l) => {
      const row = rowOfUid.get(l.uid);
      if (!row || row === i + 1) return [];
      let type: LinkType = l.type === 0 ? 'FF' : l.type === 3 ? 'SS' : 'FS';
      if (l.type === 2) { warnings.push(`${r.name}: a start-to-finish link became finish-to-start`); type = 'FS'; }
      return [{ row, lag: Math.round(l.lag / TENTHS_PER_DAY), type }];
    });
    return {
      name: r.name.slice(0, 200), duration: Math.max(0, Math.round(r.hours / 8)), parent, predecessors,
      progress: r.progress ? r.progress : null, status: r.progress === 100 ? 'done' as const : 'todo' as const,
      note: r.note, not_before: r.nb, deadline: r.deadline,
      resources: whoOfTask.get(r.uid)?.join(', ') ?? null,
      ...(r.baselines.length ? { baselines: r.baselines } : {}),
      ...estimateFor(r, Math.max(0, Math.round(r.hours / 8)), warnings),
    };
  });
  return { ok: true, rows, warnings };
}

/** A file's best and worst case, kept only when they fit around the duration; otherwise dropped with a warning. */
function estimateFor(r: { name: string; best: number | null; worst: number | null }, duration: number, warnings: string[]) {
  if (r.best == null && r.worst == null) return {};
  const problem = estimateError(duration, r.best, r.worst);
  if (problem) {
    warnings.push(`${r.name}: ${problem}, so its best and worst case were left out`);
    return {};
  }
  return { duration_low: r.best, duration_high: r.worst };
}
