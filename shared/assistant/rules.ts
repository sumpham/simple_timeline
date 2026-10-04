import { addDays, workingDays } from '../dates.ts';
import { PRIORITY_RANK, type ISODate } from '../types.ts';
import { lateBy } from '../schedule.ts';
import type { Forecast } from './forecast.ts';
import { workingDaysAfter, type PlanFacts, type TaskFacts } from './facts.ts';

/**
 * The assistant's warnings (reqs/smart_assistant.md §4.1): pure rules over
 * PlanFacts. Each returns findings with engine numbers only; the words are
 * templates filled with them, so nothing can say more than the facts do.
 */

export type FindingGroup = 'progress' | 'structure' | 'hygiene';

export type RuleId =
  | 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8'
  | 'S1' | 'S2' | 'S3' | 'S4' | 'S5' | 'S6'
  | 'H1' | 'H2' | 'H3' | 'H4' | 'H5' | 'H6' | 'H7';

export type Finding = {
  rule: RuleId;
  group: FindingGroup;
  /**
   * Identity for dismissing: the rule and the exact things it concerns. When they
   * change (another task joins, the slip grows), the key changes and a dismissed
   * finding comes back, as an accepted double-booking does.
   */
  key: string;
  title: string;
  text: string;
  /** Short lines of numbers behind the sentence. */
  evidence: string[];
  /** The tasks to show when asked; in plan order. */
  task_ids: number[];
  /** 1–5 each; severity is their product, as in a probability-impact matrix. */
  likelihood: number;
  impact: number;
  severity: number;
  dismissed?: boolean;
};

/** What the assistant says about one plan (GET /api/projects/:id/assistant). */
export type AssistantReport = {
  status_date: ISODate;
  findings: Finding[];
  /** The Monte Carlo forecast; null when the plan has no unfinished work to forecast. */
  forecast: Forecast | null;
  /** Better plans are found on request (GET …/assistant/suggestions), so always empty here. */
  suggestions: [];
  /** Whether an LLM advisor is turned on, and which; `none` keeps everything on the machine. */
  advisor?: { provider: string; on: boolean };
};

export type RuleSettings = { long_task_days: number; high_float_days?: number };

/** DCMA's high-float line: more than two months of float usually means a missing link. */
export const HIGH_FLOAT_DAYS = 44;
/** DCMA's line for lags: at most 5% of links should carry one. */
const LAG_SHARE = 0.05;

export const RULE_GROUP: Record<RuleId, FindingGroup> = {
  P1: 'progress', P2: 'progress', P3: 'progress', P4: 'progress', P5: 'progress', P6: 'progress', P7: 'progress', P8: 'progress',
  S1: 'structure', S2: 'structure', S3: 'structure', S4: 'structure', S5: 'structure', S6: 'structure',
  H1: 'hygiene', H2: 'hygiene', H3: 'hygiene', H4: 'hygiene', H5: 'hygiene', H6: 'hygiene', H7: 'hygiene',
};

// ---------------------------------------------------------------- scale

/** Working days of finish delay on a 1–5 scale, one higher for a high or critical project. */
export function impactOf(delayDays: number, facts: Pick<PlanFacts, 'project'>): number {
  const base = delayDays <= 0 ? 1 : delayDays <= 2 ? 2 : delayDays <= 5 ? 3 : delayDays <= 10 ? 4 : 5;
  return clamp(base + (PRIORITY_RANK[facts.project.priority] >= 3 && delayDays > 0 ? 1 : 0));
}

const clamp = (n: number) => Math.max(1, Math.min(5, Math.round(n)));

// ---------------------------------------------------------------- words

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const day = (d: ISODate) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]}`;
const wd = (n: number) => `${n} working day${n === 1 ? '' : 's'}`;
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** "Build API (T12)": a task as people know it. */
export function label(t: Pick<TaskFacts, 'name' | 'code'>): string {
  return t.code != null ? `${t.name} (T${t.code})` : t.name;
}

function names(ts: readonly TaskFacts[], max = 3): string {
  const shown = ts.slice(0, max).map(label);
  return ts.length > max ? `${shown.join(', ')} and ${ts.length - max} more` : shown.join(ts.length === 2 ? ' and ' : ', ');
}

// ---------------------------------------------------------------- rules

function finding(
  rule: RuleId, keyParts: readonly (string | number)[], f: Omit<Finding, 'rule' | 'group' | 'key' | 'severity'>,
): Finding {
  const likelihood = clamp(f.likelihood);
  const impact = clamp(f.impact);
  return { rule, group: RULE_GROUP[rule], key: [rule, ...keyParts].join(':'), ...f, likelihood, impact, severity: likelihood * impact };
}

const open = (t: TaskFacts) => !t.summary && t.status !== 'done';
const ids = (ts: readonly TaskFacts[]) => ts.map((t) => t.id);

/**
 * P1: the target is at risk. On the forecast's P80 when there is one (the
 * finish there is an 80% chance of meeting), else on the planned finish.
 */
function targetAtRisk(f: PlanFacts): Finding[] {
  const target = f.project.target_date;
  if (!target || !f.finish) return [];
  const fc = f.forecast;
  const p80Late = fc ? lateBy(fc.p80, target, f.holidays) : 0;
  const late = Math.max(f.late_by, p80Late);
  if (!late) return [];
  const path = f.critical_path.map((id) => f.byId.get(id)!).filter(open);
  const onTime = fc?.on_time ?? null;
  const text = f.late_by > 0
    ? `The plan finishes on ${day(f.finish)}, ${wd(f.late_by)} after the target of ${day(target)}.`
    : `The plan finishes on ${day(f.finish)}, before the target of ${day(target)}, but it has only a ${pct(onTime ?? 0)} chance of making it: at 80% confidence it finishes on ${day(fc!.p80)}.`;
  return [finding('P1', [late], {
    title: 'Target at risk',
    text: text + (path.length ? ` The critical path runs through ${names(path)}.` : ''),
    evidence: [
      `Planned finish ${day(f.finish)}`,
      ...(fc ? [`P50 ${day(fc.p50)}`, `P80 ${day(fc.p80)}`] : []),
      `Target ${day(target)}`,
      ...(onTime != null ? [`Chance on time ${pct(onTime)}`] : []),
    ],
    task_ids: ids(path),
    likelihood: onTime == null ? 5 : onTime < 0.2 ? 5 : onTime < 0.5 ? 4 : 3,
    impact: impactOf(late, f),
  })];
}

/**
 * P2: negative float. Something the plan has fixed (an actual start, a constraint)
 * cannot be met. Float a deadline took negative is P8's, which names the deadline.
 */
function negativeFloat(f: PlanFacts): Finding[] {
  const neg = f.tasks.filter((t) => open(t) && t.total_float < 0 && !t.deadline_driven);
  if (!neg.length) return [];
  const worst = Math.min(...neg.map((t) => t.total_float));
  return [finding('P2', ids(neg), {
    title: 'Negative float',
    text: `${names(neg)} ${neg.length === 1 ? 'has' : 'have'} negative float: the plan's fixed dates cannot all be met. The worst is ${wd(-worst)} short.`,
    evidence: neg.slice(0, 5).map((t) => `${label(t)}: float ${t.total_float}`),
    task_ids: ids(neg),
    likelihood: 5,
    impact: impactOf(-worst, f),
  })];
}

/**
 * P8: a deadline at risk (reqs/pm_features.md §3.4). A working task past its
 * deadline in the plan, or likely to be: its forecast P80 lands after it. Keyed on
 * the days late at P80, so a dismissed warning comes back if it gets worse.
 */
function deadlineAtRisk(f: PlanFacts): Finding[] {
  const fc = new Map((f.forecast?.deadlines ?? []).map((d) => [d.id, d]));
  return f.tasks
    .filter((t) => open(t) && t.deadline != null && t.deadline_slack != null)
    .flatMap((t) => {
      const d = fc.get(t.id);
      const planned = Math.max(0, -t.deadline_slack!);
      const p80Late = d ? lateBy(d.p80, t.deadline!, f.holidays) : 0;
      const late = Math.max(planned, p80Late);
      if (!late) return [];
      const text = planned > 0
        ? `${label(t)} finishes on ${day(t.end)}, ${wd(planned)} after its deadline of ${day(t.deadline!)}.`
        : `${label(t)} finishes on ${day(t.end)}, before its deadline of ${day(t.deadline!)}, but it has only a ${pct(d!.on_time)} chance of making it: at 80% confidence it finishes on ${day(d!.p80)}.`;
      return [finding('P8', [t.id, late], {
        title: 'Deadline at risk',
        text,
        evidence: [
          `Finishes ${day(t.end)}`,
          ...(d ? [`P80 ${day(d.p80)}`] : []),
          `Deadline ${day(t.deadline!)}`,
          ...(d ? [`Chance on time ${pct(d.on_time)}`] : []),
        ],
        task_ids: [t.id],
        likelihood: planned > 0 ? 5 : d!.on_time < 0.2 ? 5 : d!.on_time < 0.5 ? 4 : 3,
        impact: impactOf(late, f),
      })];
    });
}

/** P3: not started, and its scheduled start has passed. */
function shouldHaveStarted(f: PlanFacts): Finding[] {
  return f.tasks
    .filter((t) => !t.summary && (t.status === 'todo' || t.status === 'blocked') && t.start < f.status_date)
    .map((t) => {
      // Working days it has been waiting: from its start up to, not including, the status date.
      const overdue = workingDays(t.start, addDays(f.status_date, -1), f.holidays);
      const late = Math.max(0, overdue - Math.max(0, t.total_float));
      return finding('P3', [t.id], {
        title: 'Should have started',
        text: `${label(t)} should have started on ${day(t.start)} and is still ${t.status === 'blocked' ? 'blocked' : 'to do'}.`
          + (late > 0 ? ` Its float is used up, so each day it waits moves the finish.` : ` It has ${wd(t.total_float)} of float left.`),
        evidence: [`Scheduled start ${day(t.start)}`, `Waiting ${wd(Math.max(1, overdue))}`, `Float ${t.total_float}`],
        task_ids: [t.id],
        likelihood: 4,
        impact: t.critical ? Math.max(3, impactOf(late, f)) : impactOf(late, f),
      });
    });
}

/** P4: work in progress running slower than planned (earned schedule). */
function slipping(f: PlanFacts): Finding[] {
  return f.tasks
    .filter((t) => open(t) && t.spi != null && t.slip > 0 && (t.spi < 0.9 || t.slip > t.free_float))
    .map((t) => {
      const delay = Math.max(0, t.slip - Math.max(0, t.total_float));
      return finding('P4', [t.id], {
        title: 'Falling behind',
        text: `${label(t)} is ${t.progress}% done at a pace of ${pct(t.spi!)} of plan. At this rate it finishes ${wd(t.slip)} late`
          + (delay > 0 ? `, which moves the project finish by about ${wd(delay)}.` : `, inside its ${wd(t.total_float)} of float.`),
        evidence: [`Progress ${t.progress}%`, `Pace ${t.spi!.toFixed(2)}`, `Projected slip ${wd(t.slip)}`, `Float ${t.total_float}`],
        task_ids: [t.id],
        likelihood: t.spi! < 0.6 ? 5 : t.spi! < 0.75 ? 4 : 3,
        impact: delay > 0 ? impactOf(delay, f) : 2,
      });
    });
}

/** P5: blocked work on or near the critical path. */
function blockedCritical(f: PlanFacts): Finding[] {
  return f.tasks
    .filter((t) => open(t) && t.status === 'blocked' && (t.critical || t.near_critical))
    .map((t) => finding('P5', [t.id], {
      title: 'Blocked on the critical path',
      text: `${label(t)} is blocked and ${t.critical ? 'on the critical path' : `has only ${wd(t.total_float)} of float`}. Every day it stays blocked`
        + `${t.critical ? ' moves the finish' : ' uses up that float'}.`,
      evidence: [`Status blocked`, `Float ${t.total_float}`, `Scheduled ${day(t.start)} – ${day(t.end)}`],
      task_ids: [t.id],
      likelihood: 4,
      impact: t.critical ? 4 : 3,
    }));
}

/** P6: the room between finish and target has shrunk by more than half since the baseline. */
function floatErosion(f: PlanFacts): Finding[] {
  if (!f.baseline || !f.project.target_date || f.target_slack == null || f.late_by > 0) return [];
  const was = f.baseline.finish <= f.project.target_date ? workingDaysAfter(f.baseline.finish, f.project.target_date, f.holidays) : 0;
  if (was <= 0 || f.target_slack >= was * 0.5) return [];
  return [finding('P6', [f.target_slack], {
    title: 'Margin shrinking',
    text: `At the baseline the plan had ${wd(was)} to spare before the target; now it has ${wd(f.target_slack)}.`,
    evidence: [`Baseline finish ${day(f.baseline.finish)}`, `Finish ${day(f.finish!)}`, `Target ${day(f.project.target_date)}`],
    task_ids: [],
    likelihood: 3,
    impact: f.target_slack <= 2 ? 4 : 3,
  })];
}

/** P7: behind the baseline, by tasks finished (DCMA BEI) or by finish date. */
function baselineSlip(f: PlanFacts): Finding[] {
  if (!f.baseline || !f.finish) return [];
  const { due, done } = f.baseline;
  const bei = due.length ? done.length / due.length : 1;
  const slip = f.finish > f.baseline.finish ? workingDaysAfter(f.baseline.finish, f.finish, f.holidays) : 0;
  if (bei >= 0.95 && slip === 0) return [];
  const behind = due.filter((id) => !done.includes(id)).map((id) => f.byId.get(id)!);
  const parts: string[] = [];
  if (bei < 0.95) parts.push(`${done.length} of ${due.length} tasks due by now under the baseline are done`);
  if (slip > 0) parts.push(`the finish is ${wd(slip)} later than the baseline's ${day(f.baseline.finish)}`);
  return [finding('P7', [...ids(behind), slip], {
    title: 'Behind the baseline',
    text: `${capital(parts.join(', and '))}.`,
    evidence: [
      ...(due.length ? [`Baseline Execution Index ${bei.toFixed(2)}`] : []),
      ...(slip ? [`Finish variance +${slip}`] : []),
    ],
    task_ids: ids(behind),
    likelihood: slip > 0 ? 5 : bei < 0.7 ? 5 : bei < 0.85 ? 4 : 3,
    impact: Math.max(2, impactOf(slip, f)),
  })];
}

const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** S1: tasks that a small slip would make critical. */
function nearCritical(f: PlanFacts): Finding[] {
  const near = f.tasks.filter((t) => open(t) && t.near_critical);
  if (!near.length) return [];
  return [finding('S1', ids(near), {
    title: 'Close to critical',
    text: `${names(near)} ${near.length === 1 ? 'is' : 'are'} within ${wd(f.near_critical_days)} of the critical path. A small slip there moves the finish.`,
    evidence: near.slice(0, 5).map((t) => `${label(t)}: float ${t.total_float}`),
    task_ids: ids(near),
    likelihood: 3,
    impact: 3,
  })];
}

/** S2: a critical task waiting on many others (merge bias: it starts late more often than CPM says). */
function mergePoints(f: PlanFacts): Finding[] {
  return f.tasks
    .filter((t) => open(t) && t.critical && t.preds.length >= 3)
    .map((t) => {
      const preds = t.preds.map((id) => f.byId.get(id)!);
      return finding('S2', [t.id, ...t.preds], {
        title: 'Many paths meet here',
        text: `${label(t)} is critical and waits on ${preds.length} tasks. It starts on time only if all of them finish on time, which is less likely than any one of them.`,
        evidence: [`Predecessors: ${names(preds, 4)}`],
        task_ids: [t.id, ...t.preds],
        likelihood: preds.length >= 5 ? 4 : 3,
        impact: 3,
      });
    });
}

/**
 * S3: little room between finish and target (DCMA #13, Critical Path Length
 * Index, near 1). Below 1 the plan is late, which P1 says; this warns before that.
 */
function thinMargin(f: PlanFacts): Finding[] {
  if (f.target_slack == null || f.late_by > 0 || f.remaining_length <= 0) return [];
  const cpli = (f.remaining_length + f.target_slack) / f.remaining_length;
  if (cpli >= 1.05) return [];
  return [finding('S3', [f.target_slack], {
    title: 'Thin margin to target',
    text: `Only ${wd(f.target_slack)} stand between the finish and the target, on ${wd(f.remaining_length)} of work still ahead. A slip of ${pct(cpli - 1)} on the critical path makes it late.`,
    evidence: [`Critical Path Length Index ${cpli.toFixed(2)}`, `Margin ${wd(f.target_slack)}`],
    task_ids: f.critical_path.filter((id) => open(f.byId.get(id)!)),
    likelihood: 3,
    impact: 3,
  })];
}

/** S4: an open double-booking on an environment that critical or near-critical work needs. */
function clashOnPath(f: PlanFacts): Finding[] {
  const out: Finding[] = [];
  for (const cl of f.clashes) {
    const hit = cl.task_ids.map((id) => f.byId.get(id)!).filter((t) => t.critical || t.near_critical);
    if (!hit.length) continue;
    const c = cl.conflict;
    const others = cl.others.map((p) => p.name);
    out.push(finding('S4', [c.environment_id, ...[...c.booking_ids].sort((a, b) => a - b)], {
      title: 'Double-booked where the plan is tight',
      text: `${c.env_name} is double-booked ${day(c.start_date)} – ${day(c.end_date)}${others.length ? ` with ${others.join(', ')}` : ''}, while ${names(hit)} ${hit.length === 1 ? 'needs' : 'need'} it${hit.some((t) => t.critical) ? ' on the critical path' : ' with little float'}.`,
      evidence: [`${c.peak} bookings, room for ${c.capacity}`, `${c.overlap_days} day${c.overlap_days === 1 ? '' : 's'} of overlap`],
      task_ids: ids(hit),
      likelihood: 4,
      impact: hit.some((t) => t.critical) ? 4 : 3,
    }));
  }
  return out;
}

/** S5: one person on critical tasks that run at the same time. */
function overloadedOnCritical(f: PlanFacts, people: ReadonlyMap<number, string>): Finding[] {
  const byPerson = new Map<number, TaskFacts[]>();
  for (const t of f.tasks) {
    if (!open(t) || !t.critical) continue;
    for (const p of t.people) (byPerson.get(p) ?? byPerson.set(p, []).get(p)!).push(t);
  }
  const out: Finding[] = [];
  for (const [person, ts] of byPerson) {
    const clash = ts.filter((a) => ts.some((b) => b !== a && a.start <= b.end && b.start <= a.end));
    if (clash.length < 2) continue;
    const who = people.get(person) ?? 'Someone';
    out.push(finding('S5', [person, ...ids(clash)], {
      title: 'One person, parallel critical work',
      text: `${who} is on ${names(clash)} at the same time, all on the critical path. If ${who} can only do one at once, the finish moves.`,
      evidence: clash.slice(0, 4).map((t) => `${label(t)}: ${day(t.start)} – ${day(t.end)}`),
      task_ids: ids(clash),
      likelihood: 4,
      impact: 4,
    }));
  }
  return out;
}

/**
 * H7: a person on two tasks at once (reqs/pm_features.md §5): its dates assume
 * someone does two things in the same days. Counts their work in other plans.
 * Two critical tasks of this plan are S5's, which says what it does to the finish.
 */
function personOnTwoTasks(f: PlanFacts, people: ReadonlyMap<number, string>): Finding[] {
  return f.overlaps.flatMap((o) => {
    const a = f.byId.get(o.a);
    const b = f.byId.get(o.b);
    const here = [a, b].filter((t): t is TaskFacts => !!t);
    if (!here.some(open)) return [];
    if (a && b && a.critical && b.critical) return [];
    const who = people.get(o.resource_id) ?? 'Someone';
    const name = (id: number) => {
      const s = o.spans[id];
      return s.here ? label({ name: s.name, code: s.code }) : `${s.name} (in ${s.project_name ?? 'another plan'})`;
    };
    const critical = here.some((t) => t.critical);
    return [finding('H7', [o.resource_id, Math.min(o.a, o.b), Math.max(o.a, o.b)], {
      title: 'Person on two tasks at once',
      text: `${who} is on ${name(o.a)} and ${name(o.b)} at once for ${wd(o.days)}, ${day(o.start)} – ${day(o.end)}. `
        + `The dates assume both get done in those days${critical ? ', and one of them is critical' : ''}.`,
      evidence: [o.a, o.b].map((id) => `${name(id)}: ${day(o.spans[id].start)} – ${day(o.spans[id].end)}`),
      task_ids: here.map((t) => t.id),
      likelihood: o.days >= 5 ? 4 : 3,
      impact: critical ? 3 : 2,
    })];
  });
}

/** S6: critical work nobody is on, in a plan that does name people. */
function unassignedCritical(f: PlanFacts): Finding[] {
  if (!f.tasks.some((t) => t.people.length)) return [];
  const none = f.tasks.filter((t) => open(t) && t.critical && !t.people.length && t.duration > 0);
  if (!none.length) return [];
  return [finding('S6', ids(none), {
    title: 'Critical work with nobody on it',
    text: `${names(none)} ${none.length === 1 ? 'is' : 'are'} on the critical path with no one assigned.`,
    evidence: [`${none.length} critical task${none.length === 1 ? '' : 's'} unassigned`],
    task_ids: ids(none),
    likelihood: 2,
    impact: 3,
  })];
}

/** H1: loose ends. A task with no successor has float measured to the project's end, which means little. */
function missingLogic(f: PlanFacts): Finding[] {
  const working = f.tasks.filter((t) => !t.summary);
  if (working.length < 3) return [];
  const live = working.filter((t) => open(t) && t.duration > 0);
  const noSuccessor = live.filter((t) => !t.succs.length && t.total_float > 0);
  const dateOnly = live.filter((t) => !t.preds.length && t.driven_by_constraint && !noSuccessor.includes(t));
  const loose = [...noSuccessor, ...dateOnly];
  if (!loose.length) return [];
  const parts = [
    ...(noSuccessor.length ? [`${names(noSuccessor)} ${noSuccessor.length === 1 ? 'feeds' : 'feed'} nothing, so ${noSuccessor.length === 1 ? 'its' : 'their'} float is only measured to the project's end`] : []),
    ...(dateOnly.length ? [`${names(dateOnly)} ${dateOnly.length === 1 ? 'starts' : 'start'} from a date alone, with no task before ${dateOnly.length === 1 ? 'it' : 'them'}`] : []),
  ];
  return [finding('H1', ids(loose), {
    title: 'Missing links',
    text: `${capital(parts.join('; '))}. Link ${loose.length === 1 ? 'it' : 'them'} to the work ${loose.length === 1 ? 'it depends on and feeds' : 'they depend on and feed'}.`,
    evidence: [`${loose.length} of ${working.length} tasks (DCMA: at most 5%)`],
    task_ids: ids(loose),
    likelihood: 2,
    impact: 2,
  })];
}

/** H2: leads (negative lag) hide overlap the plan cannot see. */
function leads(f: PlanFacts): Finding[] {
  const neg = f.raw_links.filter((d) => d.lag < 0);
  if (!neg.length) return [];
  const pairs = neg.map((d) => `${label(f.byId.get(d.predecessor_id)!)} → ${label(f.byId.get(d.successor_id)!)} (${d.lag})`);
  return [finding('H2', neg.map((d) => `${d.predecessor_id}>${d.successor_id}`), {
    title: 'Leads',
    text: `${neg.length} link${neg.length === 1 ? ' has' : 's have'} a negative lag. A start-to-start link says the same thing openly.`,
    evidence: pairs.slice(0, 4),
    task_ids: [...new Set(neg.flatMap((d) => [d.predecessor_id, d.successor_id]))],
    likelihood: 2,
    impact: 2,
  })];
}

/** H3: lags longer than the work they hold, or on more than 5% of links. */
function lags(f: PlanFacts): Finding[] {
  const lagged = f.raw_links.filter((d) => d.lag > 0);
  const long = lagged.filter((d) => d.lag > (f.byId.get(d.successor_id)?.duration ?? 0));
  const tooMany = f.raw_links.length >= 10 && lagged.length / f.raw_links.length > LAG_SHARE;
  const flagged = tooMany ? lagged : long;
  if (!flagged.length) return [];
  return [finding('H3', flagged.map((d) => `${d.predecessor_id}>${d.successor_id}`), {
    title: 'Lags',
    text: tooMany
      ? `${lagged.length} of ${f.raw_links.length} links carry a lag (DCMA: at most 5%). A lag is waiting nobody can see; a task says what it is.`
      : `${flagged.length} link${flagged.length === 1 ? ' waits' : 's wait'} longer than the task that follows. Consider a task for that wait.`,
    evidence: flagged.slice(0, 4).map((d) => `${label(f.byId.get(d.predecessor_id)!)} → ${label(f.byId.get(d.successor_id)!)} (+${d.lag})`),
    task_ids: [...new Set(flagged.flatMap((d) => [d.predecessor_id, d.successor_id]))],
    likelihood: 2,
    impact: 2,
  })];
}

/** H4: a "start no earlier than" that is holding a task back right now. */
function drivingConstraints(f: PlanFacts): Finding[] {
  return f.tasks
    .filter((t) => open(t) && t.driven_by_constraint)
    .map((t) => finding('H4', [t.id, t.start], {
      title: 'Held by a date',
      text: `${label(t)} could start earlier, but a "start no earlier than" holds it to ${day(t.start)}.${t.critical ? ' It is on the critical path, so the date sets the finish.' : ''}`,
      evidence: [`Starts ${day(t.start)}`, ...(t.not_before ? [`Start no earlier than ${day(t.not_before)}`] : ['Held by its summary']), `Float ${t.total_float}`],
      task_ids: [t.id],
      likelihood: 2,
      impact: t.critical ? 3 : 2,
    }));
}

/** H5: tasks too long to track (the 8/80 rule; a setting). */
function longTasks(f: PlanFacts, s: RuleSettings): Finding[] {
  const long = f.tasks.filter((t) => open(t) && t.duration > s.long_task_days);
  if (!long.length) return [];
  return [finding('H5', ids(long), {
    title: 'Long tasks',
    text: `${names(long)} ${long.length === 1 ? 'is' : 'are'} longer than ${wd(s.long_task_days)}. Split ${long.length === 1 ? 'it' : 'them'} so progress shows early and the next task can start on the first part.`,
    evidence: long.slice(0, 5).map((t) => `${label(t)}: ${wd(t.duration)}`),
    task_ids: ids(long),
    likelihood: 2,
    impact: long.some((t) => t.critical) ? 3 : 2,
  })];
}

/** H6: float so high it usually means a link is missing. */
function highFloat(f: PlanFacts, s: RuleSettings): Finding[] {
  const limit = s.high_float_days ?? HIGH_FLOAT_DAYS;
  const high = f.tasks.filter((t) => open(t) && t.total_float > limit);
  if (!high.length) return [];
  return [finding('H6', ids(high), {
    title: 'Very high float',
    text: `${names(high)} can slip more than ${wd(limit)} without moving the finish. That usually means a link is missing.`,
    evidence: high.slice(0, 5).map((t) => `${label(t)}: float ${t.total_float}`),
    task_ids: ids(high),
    likelihood: 2,
    impact: 1,
  })];
}

const GROUP_ORDER: Record<FindingGroup, number> = { progress: 0, structure: 1, hygiene: 2 };

/**
 * Every rule over one plan's facts, most severe first. `people` names the
 * resources the plan uses, for the words only.
 */
export function assess(f: PlanFacts, settings: RuleSettings, people: ReadonlyMap<number, string> = new Map()): Finding[] {
  const out = [
    ...targetAtRisk(f), ...deadlineAtRisk(f), ...negativeFloat(f), ...shouldHaveStarted(f), ...slipping(f), ...blockedCritical(f),
    ...floatErosion(f), ...baselineSlip(f),
    ...nearCritical(f), ...mergePoints(f), ...thinMargin(f), ...clashOnPath(f), ...overloadedOnCritical(f, people),
    ...unassignedCritical(f), ...personOnTwoTasks(f, people),
    ...missingLogic(f), ...leads(f), ...lags(f), ...drivingConstraints(f), ...longTasks(f, settings), ...highFloat(f, settings),
  ];
  const order = new Map(f.tasks.map((t, i) => [t.id, i]));
  for (const x of out) x.task_ids = [...new Set(x.task_ids)].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return out.sort((a, b) => b.severity - a.severity || GROUP_ORDER[a.group] - GROUP_ORDER[b.group] || a.key.localeCompare(b.key));
}
