import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { api, type BoardData, type PlanData, type SavedLayout, type TaskChange, type TaskInput } from '../api.ts';
import type {
  BookingView, Environment, ISODate, LinkType, PlanImpact, Project, Resource, Task, TaskDependency, TaskSchedule, TaskStatus,
} from '../../shared/types.ts';
import { applyResourcePick, formatResources, parseResources, resourceSuggestions, type ResourceSuggestion } from '../../shared/resources.ts';
import { formatDate, formatRange } from '../layout.ts';
import { addDays, isWorkingDay, isValidISODate, maxDate, workingDays } from '../../shared/dates.ts';
import { afterSuggestions, applySuggestion, formatPredecessors, parseAfter } from '../predecessors.ts';
import { codesById, nextTaskCode, TASK_CODE_MAX, taskIdsByCode } from '../../shared/taskCode.ts';
import { ENV_COLOR } from './Board.tsx';
import { DangerButton, Modal } from './Dialogs.tsx';
import { NetworkDiagram } from './NetworkDiagram.tsx';
import { Gantt, STRIP_HEAD, STRIP_LANE, type GanttCommand, type GanttPreview, type GanttShow, type RowBox, type StripData } from './Gantt.tsx';
import { Portfolio } from './Portfolio.tsx';
import { AssistantDrawer, openFindings } from './Assistant.tsx';
import type { AssistantReport, Finding } from '../../shared/assistant/rules.ts';
import { edgeKey, type Route } from '../network.ts';
import type { Arrangement } from '../smartLayout.ts';
import {
  descendants, indent, inOutlineOrder, leavesOf, moveAmongSiblings, moveBefore, outdent, outline, type OutlinePlacement, type OutlineRow,
} from '../../shared/wbs.ts';
import { expandLinks } from '../../shared/schedule.ts';
import { bookingsFor, conflictChanges, conflictsFor, planProject, type ImpactContext } from '../../shared/plan.ts';
import { isManaged, type ReconcileBooking } from '../../shared/taskHolds.ts';
import {
  finishFields, progressOf, rolledBaseline, rolledProgress, startFields, visibleRows, zoomToFit, ZOOM_LABEL, ZOOMS, type Zoom,
} from '../gantt.ts';
import { fromCsv, fromMspdi, toCsv, toMspdi } from '../planIO.ts';
import { estimateError, rangeOf } from '../../shared/estimates.ts';

/**
 * A project's plan: its tasks, what drives their dates, and the bookings they
 * make. A scheduling instrument rather than a to-do list, so there is no
 * kanban here: a table and its Gantt chart to enter and shape work, a network
 * to see why the dates are what they are, and the team's portfolio.
 */

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};
/** Shape, not colour: red is spent on double-bookings. */
const STATUS_GLYPH: Record<TaskStatus, string> = { todo: '○', in_progress: '◐', blocked: '‖', done: '●' };
const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

/** Fields that move dates. Changing only a name or a note needs no impact check. */
const SCHEDULE_FIELDS: (keyof TaskInput)[] = [
  'duration', 'environment_id', 'predecessors', 'status', 'not_before', 'actual_start', 'actual_end', 'parent_id',
];

type Tab = 'tasks' | 'network' | 'portfolio';

/** Tasks in outline order, so row numbers, the table and the chart all agree. */
function normalize(p: PlanData): PlanData {
  return { ...p, tasks: inOutlineOrder(p.tasks), baseline: p.baseline ?? [] };
}

export function PlanView({
  projectId, projects, environments, holidays, today, onBack, onSwitchProject, onChanged, onRelease, peopleVersion = 0,
}: {
  projectId: number;
  /** Non-working days besides weekends; a typed finish counts working days around them. */
  holidays: ReadonlySet<ISODate>;
  projects: readonly Project[];
  environments: readonly Environment[];
  today: ISODate;
  onBack: () => void;
  onSwitchProject: (id: number) => void;
  /** Something on the board may have moved; refresh it. */
  onChanged: () => void;
  onRelease: (b: BookingView) => Promise<void>;
  /** Changes when people are renamed or merged elsewhere; the plan reloads to show it. */
  peopleVersion?: number;
}) {
  const [plan, setPlanRaw] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('tasks');
  const [showEnvs, setShowEnvs] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  /** A row whose name should take the caret once it shows: a sub-task just added. */
  const [focusTask, setFocusTask] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** What the last change did, with a way to take it back. */
  const [outcome, setOutcome] = useState<{ title: string; impact: PlanImpact; undo?: () => Promise<void> } | null>(null);
  /** A typed date the schedule could not honour exactly, and why. */
  const [notice, setNotice] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  /** What the last Smart Arrange replaced, until something else moves the layout. */
  const [arrangeUndo, setArrangeUndo] = useState<SavedLayout | null>(null);
  /** The team's bookings around this plan, for the chart's occupancy strip and drag preview. */
  const [board, setBoard] = useState<BoardData | null>(null);
  /** What the assistant says about the plan as it now stands (shared/assistant/). */
  const [report, setReport] = useState<AssistantReport | null>(null);
  const [reportError, setReportError] = useState<string | null>(null);
  const [reportBusy, setReportBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(readAssistantOpen);
  /** Rows the assistant was asked to show; `at` makes asking twice show them twice. */
  const [spotlight, setSpotlight] = useState<{ ids: number[]; at: number } | null>(null);

  const setPlan = (next: PlanData | null | ((p: PlanData | null) => PlanData | null)) => setPlanRaw(next as never);

  const load = useCallback(async () => {
    try {
      setPlanRaw(normalize(await api.plan(projectId)));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the plan');
    }
  }, [projectId]);

  useEffect(() => { setPlanRaw(null); setBoard(null); setEditing(null); setOutcome(null); setArrangeUndo(null); void load(); }, [load]);
  useEffect(() => { if (peopleVersion) void load(); }, [peopleVersion]);

  // The strip and the drag preview need everyone's bookings, not just this plan's.
  const teamId = plan?.project.team_id;
  useEffect(() => {
    if (!plan || teamId == null) return;
    const from = addDays(plan.project.start_date ?? today, -60);
    const to = addDays(maxDate(plan.finish ?? today, plan.project.target_date ?? today), 180);
    let live = true;
    api.board({ team: teamId, from, to }).then((b) => { if (live) setBoard(b); }).catch(() => { if (live) setBoard(null); });
    return () => { live = false; };
  }, [plan?.schedule, plan?.bookings, teamId]);

  // Every plan change can change a warning, so the report follows the plan. The last
  // one stays up while the next loads, so the overdue marks do not flicker.
  useEffect(() => {
    if (!plan) return;
    let live = true;
    api.assistant(projectId)
      .then((r) => { if (live) { setReport(r); setReportError(null); } })
      .catch((err) => { if (live) setReportError(err instanceof Error ? err.message : 'The assistant could not read this plan'); });
    return () => { live = false; };
  }, [plan, projectId]);
  useEffect(() => { setReport(null); setSpotlight(null); }, [projectId]);
  useEffect(() => {
    try { localStorage.setItem(ASSISTANT_KEY, assistantOpen ? '1' : '0'); } catch { /* a remembered panel is a convenience */ }
  }, [assistantOpen]);

  const openWarnings = useMemo(() => openFindings(report), [report]);
  /** Tasks that should have started (rule P3), for the mark on their row. */
  const overdueIds = useMemo(() => new Set(openWarnings.filter((f) => f.rule === 'P3').flatMap((f) => f.task_ids)), [openWarnings]);

  const setAside = async (f: Finding, back: boolean) => {
    setReportBusy(true);
    try {
      setReport(back ? await api.restoreFinding(projectId, f.key) : await api.dismissFinding(projectId, f.key));
    } catch (err) { fail(err); } finally { setReportBusy(false); }
  };
  const showFinding = (f: Finding) => {
    setTab('tasks');
    setSpotlight({ ids: f.task_ids, at: Date.now() });
  };

  const schedule = useMemo(() => new Map((plan?.schedule ?? []).map((s) => [s.id, s])), [plan]);
  const rowOf = useMemo(() => new Map((plan?.tasks ?? []).map((t, i) => [t.id, i + 1])), [plan]);
  /** TaskIDs, which After is written in; rows only number the table. */
  const codeOf = useMemo(() => codesById(plan?.tasks ?? []), [plan]);
  const outlineRows = useMemo(() => new Map(outline(plan?.tasks ?? []).map((r) => [r.id, r])), [plan]);
  /** Everyone by id: tasks name their people by `resource_ids`. */
  const people = useMemo(() => new Map((plan?.resources ?? []).map((r) => [r.id, r])), [plan]);

  /** Apply a server answer: the new plan, and a nudge to the board behind us. */
  const accept = (next: PlanData) => {
    setPlanRaw(normalize(next));
    onChanged();
  };

  const fail = (err: unknown) => setError(err instanceof Error ? err.message : 'That did not work');

  /**
   * Save a change. Anything that can move dates is previewed first, so the
   * outcome can say what it did (and a loop is refused before it is written).
   */
  const save = async (change: TaskChange, title: string, undo?: () => Promise<void>): Promise<PlanData | null> => {
    if (!plan) return null;
    setNotice(null);
    setSaving(true);
    try {
      const fields = change.op === 'create' || change.op === 'update' ? change.fields : null;
      const moves = change.op !== 'update' || SCHEDULE_FIELDS.some((f) => fields && f in fields);
      const impact = moves ? await api.previewTask(projectId, change) : null;
      if (impact?.cycle) {
        setError(`That would make a loop: ${impact.cycle.join(' → ')}.`);
        return null;
      }
      let res: { plan: PlanData; id?: number };
      if (change.op === 'create') res = await api.createTask(projectId, { name: 'New task', ...change.fields } as TaskInput & { name: string }, change.after_id);
      else if (change.op === 'update') res = await api.updateTask(change.id, change.fields);
      else if (change.op === 'outline') res = await api.outlineTasks(projectId, change.placements);
      else res = await api.deleteTask(change.id, !!change.bridge, change.children);
      accept(res.plan);
      setError(null);
      if (impact && impact.risk !== 'low') setOutcome({ title, impact, undo });
      else setOutcome(null);
      return res.plan;
    } catch (err) {
      fail(err);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const updateTask = (t: Task, fields: TaskInput, title = `Updated ${t.name}`) => {
    // Undo puts back exactly the fields this change touched.
    const back: TaskInput = {};
    for (const k of Object.keys(fields) as (keyof TaskInput)[]) {
      if (k === 'predecessors') {
        back.predecessors = plan!.dependencies.filter((d) => d.successor_id === t.id)
          .map((d) => ({ id: d.predecessor_id, lag: d.lag, type: d.type ?? 'FS' }));
      } else if (k === 'resources') {
        back.resources = formatResources(t.resource_ids, people);
      } else {
        (back as Record<string, unknown>)[k] = t[k as keyof Task] ?? null;
      }
    }
    return save({ op: 'update', id: t.id, fields }, title, async () => {
      try { accept((await api.updateTask(t.id, back)).plan); setOutcome(null); } catch (err) { fail(err); }
    });
  };

  /**
   * A typed or dragged start. Dates are scheduled, so it becomes the floor the
   * task may not start before (or, once work has begun, the day it actually
   * started). The task keeps its length, so its finish moves with it.
   */
  const setStart = async (t: Task, date: ISODate): Promise<boolean> => {
    const fields = startFields(t, date);
    const next = await updateTask(t, fields, `Moved ${t.name} to start ${formatDate(date)}`);
    const got = next?.schedule.find((x) => x.id === t.id)?.start;
    if (got && got !== date && !('actual_start' in fields)) {
      setNotice(!isWorkingDay(date, holidays)
        ? `${t.name} starts ${formatDate(got)}: ${formatDate(date)} is not a working day.`
        : `${t.name} starts ${formatDate(got)}, not ${formatDate(date)}: a task it comes after finishes later. Clear After to pin it to the date.`);
    }
    return !!next;
  };

  /**
   * A typed or dragged finish sets the length: the working days from the start
   * to that day, weekends and holidays left out. A finished task records it as
   * its actual finish.
   */
  const setFinish = async (t: Task, date: ISODate): Promise<boolean> => {
    const start = schedule.get(t.id)?.start;
    if (!start) return false;
    const fields = finishFields(t, start, date, holidays);
    if (!fields) {
      setError(`${t.name} starts ${formatDate(start)}, so it cannot finish before then.`);
      return false;
    }
    const days = fields.duration;
    const next = await updateTask(t, fields, days != null
      ? `${t.name} now takes ${days} working day${days === 1 ? '' : 's'}`
      : `Moved ${t.name} to finish ${formatDate(date)}`);
    const got = next?.schedule.find((x) => x.id === t.id)?.end;
    if (got && got !== date && !isWorkingDay(date, holidays)) {
      setNotice(`${t.name} finishes ${formatDate(got)}: ${formatDate(date)} is not a working day, so it is not counted.`);
    }
    return !!next;
  };

  /** A new task as the last one under `parent`; its id, so the table can put the caret in its name. */
  const addSubTask = async (parent: Task): Promise<number | null> => {
    if (!plan) return null;
    const had = new Set(plan.tasks.map((t) => t.id));
    const next = await save({ op: 'create', fields: { name: 'New sub-task', parent_id: parent.id } }, `Added a sub-task under ${parent.name}`);
    return next?.tasks.find((t) => !had.has(t.id))?.id ?? null;
  };

  const addTask = async (name: string, code: number) => {
    const last = plan?.tasks[plan.tasks.length - 1];
    return save({ op: 'create', fields: { name, code }, after_id: last?.id ?? null }, `Added ${name}`);
  };

  /** Outline moves, undone by putting every touched task back where it was. */
  const reshape = async (placements: OutlinePlacement[] | null, title: string) => {
    if (!plan) return;
    if (!placements) return;
    const was = placements.map((p) => {
      const t = plan.tasks.find((x) => x.id === p.id)!;
      return { id: t.id, parent_id: t.parent_id ?? null, sort_order: t.sort_order };
    });
    await save({ op: 'outline', placements }, title, async () => {
      try { accept((await api.outlineTasks(projectId, was)).plan); setOutcome(null); } catch (err) { fail(err); }
    });
  };
  const move = (t: Task, delta: -1 | 1) => reshape(plan && moveAmongSiblings(plan.tasks, t.id, delta), `Moved ${t.name}`);
  const indentTask = (t: Task) => {
    const p = plan && indent(plan.tasks, t.id);
    if (!p) { setNotice(`${t.name} has no task above it at its level to go under.`); return Promise.resolve(); }
    return reshape(p, `Put ${t.name} under ${plan!.tasks.find((x) => x.id === p.find((q) => q.id === t.id)!.parent_id)?.name}`);
  };
  const outdentTask = (t: Task) => reshape(plan && outdent(plan.tasks, t.id), `Moved ${t.name} out a level`);
  /** A row dropped above another (null: at the end), taking the tasks under it along. */
  const moveTo = (t: Task, beforeId: number | null) => reshape(plan && moveBefore(plan.tasks, t.id, beforeId), `Moved ${t.name}`);

  /** A link drawn on the chart: the successor also waits for the predecessor to finish. */
  const addLink = (predId: number, succId: number) => {
    if (!plan) return Promise.resolve(null);
    const succ = plan.tasks.find((t) => t.id === succId)!;
    const pred = plan.tasks.find((t) => t.id === predId)!;
    const current = plan.dependencies.filter((d) => d.successor_id === succId);
    if (current.some((d) => d.predecessor_id === predId)) { setNotice(`${succ.name} already comes after ${pred.name}.`); return Promise.resolve(null); }
    return updateTask(succ, {
      predecessors: [...current.map((d) => ({ id: d.predecessor_id, lag: d.lag, type: d.type ?? 'FS' })), { id: predId, lag: 0, type: 'FS' }],
    }, `${succ.name} now comes after ${pred.name}`);
  };
  const changeLink = (dep: TaskDependency, next: { type: LinkType; lag: number } | null) => {
    if (!plan) return Promise.resolve(null);
    const succ = plan.tasks.find((t) => t.id === dep.successor_id)!;
    const pred = plan.tasks.find((t) => t.id === dep.predecessor_id)!;
    const preds = plan.dependencies.filter((d) => d.successor_id === succ.id)
      .filter((d) => next || d.predecessor_id !== dep.predecessor_id)
      .map((d) => (d.predecessor_id === dep.predecessor_id && next
        ? { id: d.predecessor_id, lag: next.lag, type: next.type }
        : { id: d.predecessor_id, lag: d.lag, type: d.type ?? 'FS' }));
    return updateTask(succ, { predecessors: preds }, next ? `Changed the link from ${pred.name} to ${succ.name}` : `Removed the link from ${pred.name} to ${succ.name}`);
  };

  // ---------------------------------------------------------------- the would-be plan

  const impactCtx = useMemo<ImpactContext | null>(() => (plan && board ? {
    project: { id: plan.project.id, name: plan.project.name, priority: plan.project.priority, target_date: plan.project.target_date },
    teamBookings: board.bookings,
    environments,
    resolved: new Set(board.resolved ?? []),
    holidays,
  } : null), [plan, board, environments, holidays]);

  const planInput = (tasks: Task[]) => ({
    projectStart: plan!.project.start_date ?? today,
    tasks,
    deps: plan!.dependencies,
    bookings: plan!.bookings.filter((b) => isManaged(b)) as unknown as ReconcileBooking[],
    holidays,
  });
  const baseOutcome = useMemo(() => (plan ? planProject(planInput(plan.tasks)) : null), [plan, holidays]);

  /** The plan as a drag would leave it: the shared scheduler and conflict engine, never a copy. */
  const preview = (t: Task, fields: TaskInput): GanttPreview | null => {
    if (!plan) return null;
    const { predecessors: _, ...rest } = fields;
    const after = planProject(planInput(plan.tasks.map((x) => (x.id === t.id ? { ...x, ...rest } : x))));
    if ('cycle' in after) return null;
    if (!impactCtx || !baseOutcome || 'cycle' in baseOutcome) return { schedule: after.schedule.tasks, bookings: [], conflicts: [], added: [] };
    return {
      schedule: after.schedule.tasks,
      bookings: bookingsFor(after, impactCtx),
      conflicts: conflictsFor(after, impactCtx),
      added: conflictChanges(baseOutcome, after, impactCtx).added,
    };
  };

  // ---------------------------------------------------------------- baseline, files

  const saveBaseline = async () => {
    try { accept((await api.saveBaseline(projectId)).plan); setNotice('Baseline saved: every task’s dates as they stand now.'); } catch (err) { fail(err); }
  };
  const clearBaseline = async () => {
    try { accept((await api.clearBaseline(projectId)).plan); } catch (err) { fail(err); }
  };

  const fileData = () => ({
    tasks: plan!.tasks,
    outline: [...outlineRows.values()],
    schedule,
    deps: plan!.dependencies,
    environments,
    resources: plan!.resources,
  });
  const exportCsv = () => download(`${slug(plan!.project.name)}-plan.csv`, toCsv(fileData()), 'text/csv');
  const exportXml = () => download(`${slug(plan!.project.name)}-plan.xml`,
    toMspdi({ ...fileData(), projectName: plan!.project.name, projectStart: plan!.project.start_date ?? null }), 'application/xml');
  const importFile = async (file: File) => {
    const text = await file.text();
    const parsed = /^\s*</.test(text) ? fromMspdi(text) : fromCsv(text);
    if (!parsed.ok) { setError(`Could not import ${file.name}: ${parsed.error}`); return; }
    setSaving(true);
    try {
      const res = await api.importTasks(projectId, parsed.rows);
      accept(res.plan);
      const warnings = [...parsed.warnings, ...res.warnings];
      setNotice(`Imported ${res.created} task${res.created === 1 ? '' : 's'} from ${file.name}, added after the plan’s last row.${warnings.length ? ` ${warnings.slice(0, 3).join('. ')}${warnings.length > 3 ? ` and ${warnings.length - 3} more notes` : ''}.` : ''}`);
      setError(null);
    } catch (err) { fail(err); } finally { setSaving(false); }
  };

  const project = plan?.project ?? projects.find((p) => p.id === projectId);
  const editingTask = editing != null ? plan?.tasks.find((t) => t.id === editing) ?? null : null;
  const criticalCount = plan?.critical_path.length ?? 0;
  const envById = (id: number | null) => environments.find((e) => e.id === id);

  // The network draws the working tasks; a link to a summary reaches each task under it.
  const network = useMemo(() => {
    if (!plan) return null;
    const summaries = new Set([...outlineRows.values()].filter((r) => r.summary).map((r) => r.id));
    if (!summaries.size) return { tasks: plan.tasks, deps: plan.dependencies, order: plan.order };
    const stored = new Map(plan.dependencies.map((d) => [edgeKey(d.predecessor_id, d.successor_id), d]));
    const deps = expandLinks(plan.tasks, plan.dependencies, summaries)
      .map((d) => stored.get(edgeKey(d.predecessor_id, d.successor_id)) ?? d);
    return { tasks: plan.tasks.filter((t) => !summaries.has(t.id)), deps, order: plan.order.filter((id) => !summaries.has(id)) };
  }, [plan, outlineRows]);

  // Network arrangement: layout only, so it is shown at once and saved behind the
  // scenes; a failed save reloads the plan, which puts the truth back.
  const moveTaskBox = (id: number, pos: { x: number; y: number } | null) => {
    setArrangeUndo(null);
    setPlan((p) => p && { ...p, tasks: p.tasks.map((t) => (t.id === id ? { ...t, net_x: pos?.x ?? null, net_y: pos?.y ?? null } : t)) });
    api.moveTaskBox(id, pos).catch((err) => { fail(err); void load(); });
  };
  const routeLink = (from: number, to: number, route: Route | null) => {
    setArrangeUndo(null);
    setPlan((p) => p && {
      ...p,
      dependencies: p.dependencies.map((d) => (d.predecessor_id === from && d.successor_id === to
        ? {
          ...d, route_out: route?.out ?? null, route_y: route?.y ?? null, route_in: route?.in ?? null,
          route_from: route?.from ?? null, route_to: route?.to ?? null,
        }
        : d)),
    });
    api.routeLink(from, to, route).catch((err) => { fail(err); void load(); });
  };
  const resetLayout = () => {
    setArrangeUndo(null);
    setPlan((p) => p && {
      ...p,
      tasks: p.tasks.map((t) => ({ ...t, net_x: null, net_y: null })),
      dependencies: p.dependencies.map((d) => ({ ...d, route_out: null, route_y: null, route_in: null, route_from: null, route_to: null })),
    });
    api.resetLayout(projectId).catch((err) => { fail(err); void load(); });
  };
  /** Show a whole layout at once and save it in one write. */
  const applyLayout = (layout: SavedLayout) => {
    const pos = new Map(layout.tasks.map((t) => [t.id, t]));
    const shape = new Map(layout.dependencies.map((d) => [edgeKey(d.predecessor_id, d.successor_id), d]));
    setPlan((p) => p && {
      ...p,
      tasks: p.tasks.map((t) => {
        const q = pos.get(t.id);
        return q ? { ...t, net_x: q.x, net_y: q.y } : t;
      }),
      dependencies: p.dependencies.map((d) => {
        const r = shape.get(edgeKey(d.predecessor_id, d.successor_id));
        return r ? { ...d, route_out: r.out, route_y: r.y, route_in: r.in, route_from: r.from ?? null, route_to: r.to ?? null } : d;
      }),
    });
    api.saveLayout(projectId, layout).catch((err) => { fail(err); void load(); });
  };
  const arrangeNetwork = (a: Arrangement) => {
    if (!plan || !network) return;
    // Keep exactly what is replaced, automatic places included, so Undo is exact.
    setArrangeUndo({
      tasks: plan.tasks.map((t) => ({ id: t.id, x: t.net_x ?? null, y: t.net_y ?? null })),
      dependencies: plan.dependencies.map((d) => ({
        predecessor_id: d.predecessor_id, successor_id: d.successor_id,
        out: d.route_out ?? null, y: d.route_y ?? null, in: d.route_in ?? null, from: d.route_from ?? null, to: d.route_to ?? null,
      })),
    });
    applyLayout({
      tasks: network.tasks.map((t) => {
        const p = a.positions.get(t.id);
        return { id: t.id, x: p?.x ?? null, y: p?.y ?? null };
      }),
      dependencies: plan.dependencies.map((d) => {
        const r = a.routes.get(edgeKey(d.predecessor_id, d.successor_id));
        return {
          predecessor_id: d.predecessor_id, successor_id: d.successor_id,
          out: r?.out ?? null, y: r?.y ?? null, in: r?.in ?? null, from: r?.from ?? null, to: r?.to ?? null,
        };
      }),
    });
  };
  const undoArrange = () => {
    if (!arrangeUndo) return;
    applyLayout(arrangeUndo);
    setArrangeUndo(null);
  };

  const setProjectDate = async (field: 'start_date' | 'target_date', value: string) => {
    try {
      await api.updateProject(projectId, { [field]: value || null });
      await load();
      onChanged();
    } catch (err) { fail(err); }
  };

  return (
    <section className="plan" aria-label={`Plan for ${project?.name ?? 'project'}`}>
      <header className="plan-head">
        <div className="plan-title-row">
          <button type="button" className="btn quiet plan-back" onClick={onBack}>
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" /></svg>
            Board
          </button>
          <label className="plan-project">
            <span className="visually-hidden">Project</span>
            <select value={projectId} onChange={(e) => onSwitchProject(Number(e.target.value))}>
              {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </label>
          <div className="segmented" role="group" aria-label="View">
            <button type="button" aria-pressed={tab === 'tasks'} onClick={() => setTab('tasks')}>Tasks</button>
            <button type="button" aria-pressed={tab === 'network'} onClick={() => setTab('network')}>Network</button>
            <button type="button" aria-pressed={tab === 'portfolio'} onClick={() => setTab('portfolio')}>Portfolio</button>
          </div>
          {tab !== 'portfolio' && (
            <button
              type="button"
              className="btn quiet assistant-toggle"
              aria-pressed={assistantOpen}
              aria-label={`Assistant, ${openWarnings.length} warning${openWarnings.length === 1 ? '' : 's'}`}
              onClick={() => setAssistantOpen((o) => !o)}
            >
              Assistant
              {report && <span className="assistant-count" data-empty={openWarnings.length === 0}>{openWarnings.length}</span>}
            </button>
          )}
        </div>

        {plan && tab !== 'portfolio' && (
          <dl className="plan-facts">
            <div>
              <dt><label htmlFor="plan-start">Starts</label></dt>
              <dd><input id="plan-start" type="date" value={plan.project.start_date ?? ''} onChange={(e) => void setProjectDate('start_date', e.target.value)} /></dd>
            </div>
            <div>
              <dt><label htmlFor="plan-target">Target</label></dt>
              <dd><input id="plan-target" type="date" value={plan.project.target_date ?? ''} onChange={(e) => void setProjectDate('target_date', e.target.value)} /></dd>
            </div>
            <div>
              <dt>Finishes</dt>
              <dd className={plan.late_by ? 'is-late' : ''}>
                {plan.finish ? formatDate(plan.finish) : '—'}
                {plan.late_by > 0 && <span className="late-tag">{plan.late_by} working day{plan.late_by === 1 ? '' : 's'} late</span>}
              </dd>
            </div>
            <div>
              <dt>Critical path</dt>
              <dd>{criticalCount ? `${criticalCount} task${criticalCount === 1 ? '' : 's'}` : '—'}</dd>
            </div>
            {plan.project.baseline_at && (
              <div>
                <dt>Baseline</dt>
                <dd>{formatDate(plan.project.baseline_at.slice(0, 10))}</dd>
              </div>
            )}
          </dl>
        )}
      </header>

      {notice && (
        <div className="impact-banner" role="status">
          <div className="impact-banner-text">{notice}</div>
          <button type="button" className="link-button" onClick={() => setNotice(null)}>Dismiss</button>
        </div>
      )}

      {error && <div className="error-bar" role="alert">{error}<button type="button" className="link-button" onClick={() => setError(null)}>Dismiss</button></div>}

      {outcome && (
        <ImpactBanner
          title={outcome.title}
          impact={outcome.impact}
          onUndo={outcome.undo ? () => void outcome.undo!() : undefined}
          onClose={() => setOutcome(null)}
        />
      )}

      <div className="plan-main">
      <div className="plan-body">
        {tab === 'portfolio' ? (
          teamId != null || project ? (
            <Portfolio
              teamId={(teamId ?? project!.team_id)}
              currentId={projectId}
              holidays={holidays}
              today={today}
              onOpen={(id) => { setTab('tasks'); if (id !== projectId) onSwitchProject(id); }}
            />
          ) : null
        ) : !plan ? (
          <div className="empty"><p>Loading the plan…</p></div>
        ) : tab === 'tasks' ? (
          <TaskTable
            plan={plan}
            schedule={schedule}
            rowOf={rowOf}
            codeOf={codeOf}
            outlineRows={outlineRows}
            environments={environments}
            holidays={holidays}
            today={today}
            saving={saving}
            addRef={addRef}
            board={board}
            preview={preview}
            onUpdate={(t, f) => updateTask(t, f).then(Boolean)}
            onSetStart={setStart}
            onSetFinish={setFinish}
            onAdd={(name, code) => addTask(name, code).then(Boolean)}
            onMove={move}
            onMoveTo={moveTo}
            onIndent={indentTask}
            onOutdent={outdentTask}
            onAddSub={(t) => addSubTask(t).then((id) => { if (id != null) setFocusTask(id); })}
            focusTask={focusTask}
            onFocused={() => setFocusTask(null)}
            onLink={addLink}
            onLinkChange={changeLink}
            onOpen={setEditing}
            onError={setError}
            onRelease={async (b) => { await onRelease(b); await load(); }}
            onSaveBaseline={saveBaseline}
            onClearBaseline={clearBaseline}
            onExportCsv={exportCsv}
            onExportXml={exportXml}
            onImport={importFile}
            overdue={overdueIds}
            spotlight={spotlight}
          />
        ) : network && network.tasks.length ? (
          <>
            <div className="network-toolbar">
              <label className="check">
                <input type="checkbox" checked={showEnvs} onChange={(e) => setShowEnvs(e.target.checked)} />
                Show environments
              </label>
              <label className="check">
                <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} />
                Critical path only
              </label>
            </div>
            <NetworkDiagram
              tasks={network.tasks}
              deps={network.deps}
              schedule={schedule}
              order={network.order}
              environments={environments}
              showEnvironments={showEnvs}
              criticalOnly={criticalOnly}
              onOpenTask={setEditing}
              onMoveTask={moveTaskBox}
              onRouteEdge={routeLink}
              onResetLayout={resetLayout}
              onArrange={arrangeNetwork}
              onUndoArrange={arrangeUndo ? undoArrange : undefined}
            />
          </>
        ) : (
          <div className="empty">
            <h2>No tasks yet</h2>
            <p>Add the first one and its dates are worked out for you.</p>
            <div><button type="button" className="btn" onClick={() => setTab('tasks')}>Add task</button></div>
          </div>
        )}
      </div>
      {assistantOpen && tab !== 'portfolio' && (
        <AssistantDrawer
          report={report}
          error={reportError}
          busy={reportBusy}
          target={plan?.project.target_date ?? null}
          taskLabel={(id) => {
            const t = plan?.tasks.find((x) => x.id === id);
            return t ? `${t.name} (T${codeOf.get(id)})` : `Task ${id}`;
          }}
          onClose={() => setAssistantOpen(false)}
          onShow={showFinding}
          onShowTasks={(ids) => { setTab('tasks'); setSpotlight({ ids, at: Date.now() }); }}
          onDismiss={(f) => void setAside(f, false)}
          onRestore={(f) => void setAside(f, true)}
        />
      )}
      </div>

      {plan && tab !== 'portfolio' && <Holds bookings={plan.bookings} environments={environments} onRelease={async (b) => { await onRelease(b); await load(); }} />}

      {editingTask && plan && (
        <TaskEditor
          task={editingTask}
          plan={plan}
          rowOf={rowOf}
          codeOf={codeOf}
          outlineRows={outlineRows}
          schedule={schedule.get(editingTask.id)}
          environments={environments}
          envName={(id) => envById(id)?.name}
          saving={saving}
          today={today}
          holidays={holidays}
          onClose={() => setEditing(null)}
          onSave={async (fields) => { if (await updateTask(editingTask, fields)) setEditing(null); }}
          onDelete={async (bridge, children) => {
            const summary = !!outlineRows.get(editingTask.id)?.summary;
            const title = summary && children === 'delete' ? `Deleted ${editingTask.name} and the tasks under it` : `Deleted ${editingTask.name}`;
            if (await save({ op: 'delete', id: editingTask.id, bridge, children: summary ? children : undefined }, title)) setEditing(null);
          }}
          onAddSub={() => { const parent = editingTask; setEditing(null); void addSubTask(parent).then((id) => id != null && setFocusTask(id)); }}
        />
      )}
    </section>
  );
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'plan';
}

/** Hand the browser a file to save. */
function download(name: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- chart settings

type ChartPrefs = {
  zoom: Zoom;
  show: GanttShow;
  /** The table's WBS column (1.2.3). */
  wbs: boolean;
  /** The table's Who column: the people on each task. */
  who: boolean;
  /** The table's Best and Worst columns: each task's range for the forecast. */
  estimates: boolean;
};
const PREFS_KEY = 'plan.chart';
const DEFAULT_PREFS: ChartPrefs = {
  zoom: 'day',
  show: { float: true, labels: true, baseline: true, bookings: false, strip: true },
  wbs: false,
  who: true,
  estimates: false,
};

function readPrefs(): ChartPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null');
    if (!raw || !ZOOMS.includes(raw.zoom)) return DEFAULT_PREFS;
    return { zoom: raw.zoom, show: { ...DEFAULT_PREFS.show, ...raw.show }, wbs: raw.wbs === true, who: raw.who !== false, estimates: raw.estimates === true };
  } catch {
    return DEFAULT_PREFS;
  }
}

function readCollapsed(projectId: number): Set<number> {
  try {
    const raw = JSON.parse(localStorage.getItem(`plan.collapsed.${projectId}`) ?? '[]');
    return new Set(Array.isArray(raw) ? raw.filter((x) => Number.isInteger(x)) : []);
  } catch {
    return new Set();
  }
}

const SHOW_LABEL: Record<keyof GanttShow, string> = {
  labels: 'Labels', float: 'Float', baseline: 'Baseline', bookings: 'Bookings', strip: 'Environments',
};
const SHOW_HINT: Record<keyof GanttShow, string> = {
  labels: 'Task names beside the bars',
  float: 'How far a task can slip before it moves the finish',
  baseline: 'The saved plan under each bar, and how far each finish has moved from it',
  bookings: 'The environment bookings behind the bars they come from',
  strip: 'How full each environment is, across the whole team',
};

// ---------------------------------------------------------------- task table

function TaskTable({
  plan, schedule, rowOf, codeOf, outlineRows, environments, holidays, today, saving, addRef, board, preview,
  onUpdate, onSetStart, onSetFinish, onAdd, onMove, onMoveTo, onIndent, onOutdent, onAddSub, focusTask, onFocused,
  onLink, onLinkChange, onOpen, onError, onRelease, onSaveBaseline, onClearBaseline, onExportCsv, onExportXml, onImport,
  overdue, spotlight,
}: {
  plan: PlanData;
  schedule: ReadonlyMap<number, TaskSchedule>;
  rowOf: ReadonlyMap<number, number>;
  codeOf: ReadonlyMap<number, number>;
  outlineRows: ReadonlyMap<number, OutlineRow>;
  environments: readonly Environment[];
  holidays: ReadonlySet<ISODate>;
  today: ISODate;
  saving: boolean;
  addRef: React.RefObject<HTMLInputElement>;
  board: BoardData | null;
  preview: (t: Task, fields: TaskInput) => GanttPreview | null;
  onUpdate: (t: Task, fields: TaskInput) => Promise<boolean>;
  onSetStart: (t: Task, date: ISODate) => Promise<boolean>;
  onSetFinish: (t: Task, date: ISODate) => Promise<boolean>;
  onAdd: (name: string, code: number) => Promise<boolean>;
  onMove: (t: Task, delta: -1 | 1) => Promise<void>;
  onMoveTo: (t: Task, beforeId: number | null) => Promise<void>;
  onIndent: (t: Task) => Promise<void>;
  onOutdent: (t: Task) => Promise<void>;
  onAddSub: (parent: Task) => Promise<void>;
  focusTask: number | null;
  onFocused: () => void;
  onLink: (predecessorId: number, successorId: number) => Promise<unknown>;
  onLinkChange: (dep: TaskDependency, next: { type: LinkType; lag: number } | null) => Promise<unknown>;
  onOpen: (id: number) => void;
  onError: (msg: string | null) => void;
  onRelease: (b: BookingView) => Promise<void>;
  onSaveBaseline: () => Promise<void>;
  onClearBaseline: () => Promise<void>;
  onExportCsv: () => void;
  onExportXml: () => void;
  onImport: (file: File) => Promise<void>;
  /** Tasks the assistant says should have started (rule P3). */
  overdue: ReadonlySet<number>;
  /** Rows to bring into view and mark for a moment. */
  spotlight: { ids: number[]; at: number } | null;
}) {
  const [draft, setDraft] = useState('');
  /** The new task's ID as typed; null offers the next free one. */
  const [codeDraft, setCodeDraft] = useState<string | null>(null);
  const nextCode = nextTaskCode(plan.tasks);
  const idOfCode = useMemo(() => taskIdsByCode(plan.tasks), [plan.tasks]);
  const choices = useMemo(() => plan.tasks.map((t) => ({ id: t.id, code: codeOf.get(t.id)!, name: t.name })), [plan.tasks, codeOf]);
  const people = useMemo(() => new Map(plan.resources.map((r) => [r.id, r])), [plan.resources]);
  const tableRef = useRef<HTMLTableElement>(null);
  const splitRef = useRef<HTMLDivElement>(null);
  /** The two sides of the split: each scrolls sideways on its own, and up and down together. */
  const tablePaneRef = useRef<HTMLDivElement>(null);
  const chartPaneRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [prefs, setPrefs] = useState<ChartPrefs>(readPrefs);
  const [query, setQuery] = useState('');
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [command, setCommand] = useState<GanttCommand | null>(null);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => readCollapsed(plan.project.id));

  useEffect(() => { setCollapsed(readCollapsed(plan.project.id)); }, [plan.project.id]);
  useEffect(() => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* a remembered view is a convenience */ }
  }, [prefs]);
  const keepCollapsed = (next: Set<number>) => {
    try { localStorage.setItem(`plan.collapsed.${plan.project.id}`, JSON.stringify([...next])); } catch { /* convenience */ }
    return next;
  };
  const toggle = (id: number) => setCollapsed((c) => {
    const next = new Set(c);
    if (next.has(id)) next.delete(id); else next.add(id);
    return keepCollapsed(next);
  });
  /** Show the outline to `level` (1 is top-level tasks only); null opens everything. */
  const showLevel = (level: number | null) => setCollapsed(keepCollapsed(new Set(
    [...outlineRows.values()].filter((r) => r.summary && level != null && r.depth >= level - 1).map((r) => r.id),
  )));
  const deepest = Math.max(0, ...[...outlineRows.values()].filter((r) => r.summary).map((r) => r.depth + 1));

  // A sub-task just added: open the summaries above it, then put the caret in its name.
  useEffect(() => {
    if (focusTask == null) return;
    const row = outlineRows.get(focusTask);
    if (!row) return;
    const above: number[] = [];
    for (let p = row.parent_id, guard = 0; p != null && guard < 64; p = outlineRows.get(p)?.parent_id ?? null, guard++) above.push(p);
    if (above.some((id) => collapsed.has(id))) {
      setCollapsed((c) => keepCollapsed(new Set([...c].filter((id) => !above.includes(id)))));
      return;
    }
    const input = tableRef.current?.querySelector<HTMLInputElement>(`[data-task="${focusTask}"] [data-field="name"]`);
    onFocused();
    if (!input) return;
    input.focus();
    input.select();
  }, [focusTask, outlineRows, collapsed]);

  /** The table's share of the split, in pixels; null is the table's full width. */
  const [tableWidth, setTableWidth] = useState<number | null>(readSplit);
  useEffect(() => {
    try {
      if (tableWidth == null) localStorage.removeItem(SPLIT_KEY);
      else localStorage.setItem(SPLIT_KEY, String(tableWidth));
    } catch { /* a remembered width is a convenience */ }
  }, [tableWidth]);

  // ------------------------------------------------------------ what shows

  const q = query.trim().toLowerCase();
  const visible = useMemo(() => visibleRows(
    [...outlineRows.values()],
    (id) => {
      const t = plan.tasks.find((x) => x.id === id)!;
      if (criticalOnly && !schedule.get(id)?.critical) return false;
      return !q || t.name.toLowerCase().includes(q) || formatResources(t.resource_ids, people).toLowerCase().includes(q) || String(codeOf.get(id)) === q;
    },
    collapsed,
  ), [outlineRows, plan.tasks, schedule, criticalOnly, q, collapsed, codeOf, people]);
  const hiddenCount = plan.tasks.length - visible.size;

  // The assistant asked to see some rows: clear what hides them, open the summaries
  // above them, then bring the first into view and mark them all for a moment.
  const [lit, setLit] = useState<ReadonlySet<number>>(new Set());
  const [pendingSpot, setPendingSpot] = useState<number[] | null>(null);
  useEffect(() => {
    if (!spotlight?.ids.length) return;
    setQuery('');
    setCriticalOnly(false);
    const above = new Set<number>();
    for (const id of spotlight.ids) {
      for (let p = outlineRows.get(id)?.parent_id ?? null, guard = 0; p != null && guard < 64; p = outlineRows.get(p)?.parent_id ?? null, guard++) above.add(p);
    }
    if ([...above].some((id) => collapsed.has(id))) setCollapsed((c) => keepCollapsed(new Set([...c].filter((id) => !above.has(id)))));
    setPendingSpot(spotlight.ids);
    setLit(new Set(spotlight.ids));
    const off = window.setTimeout(() => setLit(new Set()), 2600);
    return () => window.clearTimeout(off);
  }, [spotlight]);
  useEffect(() => {
    if (!pendingSpot) return;
    const first = pendingSpot.find((id) => visible.has(id));
    if (first == null) return;
    tableRef.current?.querySelector<HTMLElement>(`tr[data-task="${first}"]`)?.scrollIntoView({ block: 'center', inline: 'nearest' });
    setPendingSpot(null);
  }, [pendingSpot, visible]);

  const progress = useMemo(() => {
    const out = new Map<number, number>();
    for (const t of plan.tasks) if (!outlineRows.get(t.id)?.summary) out.set(t.id, progressOf(t, today, holidays));
    for (const t of plan.tasks) {
      if (!outlineRows.get(t.id)?.summary) continue;
      const parts = leavesOf(plan.tasks, t.id).map((id) => ({
        progress: out.get(id) ?? 0, duration: plan.tasks.find((x) => x.id === id)?.duration ?? 0,
      }));
      out.set(t.id, rolledProgress(parts));
    }
    return out;
  }, [plan.tasks, outlineRows, today, holidays]);

  const baseline = useMemo(
    () => rolledBaseline(plan.tasks, new Map(plan.baseline.map((b) => [b.task_id, { start: b.start_date, end: b.end_date }]))),
    [plan.baseline, plan.tasks],
  );

  const strip = useMemo<StripData | null>(() => {
    if (!board) return null;
    const used = new Set<number>([
      ...plan.tasks.map((t) => t.environment_id).filter((x): x is number => x != null),
      ...plan.bookings.map((b) => b.environment_id),
    ]);
    const envs = environments.filter((e) => used.has(e.id));
    return envs.length ? { environments: envs, bookings: board.bookings, conflicts: board.conflicts } : null;
  }, [board, plan.tasks, plan.bookings, environments]);

  // ------------------------------------------------------------ geometry

  /** Where each row sits, so the chart beside the table draws at the table's heights. */
  const [geometry, setGeometry] = useState<{ rows: Map<number, RowBox>; head: number; height: number }>(
    { rows: new Map(), head: 0, height: 0 },
  );

  useLayoutEffect(() => {
    const table = tableRef.current;
    if (!table) return;
    const measure = () => {
      const rows = new Map<number, RowBox>();
      for (const tr of table.querySelectorAll<HTMLTableRowElement>('tr[data-task]')) {
        rows.set(Number(tr.dataset.task), { top: tr.offsetTop, height: tr.offsetHeight });
      }
      const head = table.tHead?.offsetHeight ?? 0;
      const height = table.offsetHeight;
      setGeometry((g) => (g.head === head && g.height === height && sameRows(g.rows, rows) ? g : { rows, head, height }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(table);
    return () => ro.disconnect();
  }, [plan, visible]);

  // ------------------------------------------------------------ two scrollers

  /**
   * The table and the chart scroll sideways on their own but always up and down
   * together, so a bar stays beside its row. Whichever side the user scrolls
   * leads; the echo from setting the other side is ignored for a frame.
   */
  const leading = useRef<HTMLDivElement | null>(null);
  const followScroll = (from: HTMLDivElement) => {
    if (leading.current && leading.current !== from) return;
    const to = from === tablePaneRef.current ? chartPaneRef.current : tablePaneRef.current;
    if (!to || to.scrollTop === from.scrollTop) return;
    leading.current = from;
    to.scrollTop = from.scrollTop;
    requestAnimationFrame(() => { leading.current = null; });
  };

  // Both sides must be able to scroll equally far, or the last rows drift apart
  // (a sideways scrollbar on one side only takes height from that side).
  useLayoutEffect(() => {
    const a = tablePaneRef.current;
    const b = chartPaneRef.current;
    if (!a || !b) return;
    const even = () => {
      a.style.paddingBottom = '';
      b.style.paddingBottom = '';
      const ra = a.scrollHeight - a.clientHeight;
      const rb = b.scrollHeight - b.clientHeight;
      if (ra < rb) a.style.paddingBottom = `${rb - ra}px`;
      else if (rb < ra) b.style.paddingBottom = `${ra - rb}px`;
      b.scrollTop = a.scrollTop;
    };
    even();
    const ro = new ResizeObserver(even);
    for (const el of [a, b, ...a.children, ...b.children]) ro.observe(el);
    return () => ro.disconnect();
  }, [plan.tasks.length > 0, geometry.height, prefs.show.strip, tableWidth]);

  // ------------------------------------------------------------ divider

  /** Keep the divider where both sides still show something. */
  const clampSplit = (w: number) => {
    const room = splitRef.current?.clientWidth ?? w + SPLIT_MIN_CHART;
    return Math.round(Math.max(SPLIT_MIN_TABLE, Math.min(w, room - SPLIT_MIN_CHART)));
  };
  const currentSplit = () => tableRef.current?.parentElement?.offsetWidth ?? TABLE_WIDTH;

  const startSplitDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    handle.setPointerCapture(e.pointerId);
    const x0 = e.clientX;
    const w0 = currentSplit();
    const move = (ev: PointerEvent) => setTableWidth(clampSplit(w0 + ev.clientX - x0));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const splitKeys = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 80 : 16;
    if (e.key === 'ArrowLeft') setTableWidth(clampSplit(currentSplit() - step));
    else if (e.key === 'ArrowRight') setTableWidth(clampSplit(currentSplit() + step));
    else if (e.key === 'Home') setTableWidth(SPLIT_MIN_TABLE);
    else if (e.key === 'End' || e.key === 'Enter') setTableWidth(null);
    else return;
    e.preventDefault();
  };

  const fit = () => {
    const starts = [...schedule.values()].map((s) => s.start).sort();
    const ends = [...schedule.values()].map((s) => s.end).sort();
    if (!starts.length) return;
    const room = (splitRef.current?.clientWidth ?? 1200) - currentSplit() - 24;
    setPrefs((p) => ({ ...p, zoom: zoomToFit(starts[0], ends[ends.length - 1], room) }));
    setCommand((c) => ({ kind: 'start', n: (c?.n ?? 0) + 1 }));
  };

  // ------------------------------------------------------------ keys

  /** Alt+↑/↓ reorders among siblings, Alt+Shift+→/← indents and outdents; the caret stays in its cell. */
  const rowKeys = (e: KeyboardEvent, t: Task) => {
    if (!e.altKey) return;
    const indentKey = e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft');
    const moveKey = !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown');
    if (!indentKey && !moveKey) return;
    e.preventDefault();
    const field = (e.target as HTMLElement).dataset.field;
    const done = moveKey ? onMove(t, e.key === 'ArrowUp' ? -1 : 1) : e.key === 'ArrowRight' ? onIndent(t) : onOutdent(t);
    void done.then(() => requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLElement>(`[data-task="${t.id}"] [data-field="${field}"]`)?.focus();
    }));
  };

  const submitNew = async () => {
    const name = draft.trim();
    if (!name) return;
    const code = codeDraft == null ? nextCode : checkCode(codeDraft, null);
    if (code == null) return;
    if (await onAdd(name, code)) { setDraft(''); setCodeDraft(null); }
    requestAnimationFrame(() => addRef.current?.focus());
  };

  /** A typed ID, or null after saying what is wrong with it. */
  const checkCode = (text: string, own: number | null): number | null => {
    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 1 || n > TASK_CODE_MAX) { onError(`An ID is a whole number, 1 to ${TASK_CODE_MAX}.`); return null; }
    const holder = idOfCode.get(n);
    if (holder != null && holder !== own) {
      onError(`ID ${n} is already ${plan.tasks.find((x) => x.id === holder)?.name}; pick another.`);
      return null;
    }
    return n;
  };

  // ------------------------------------------------------------ drag to reorder

  /** The row being dragged, and the row it would land above (null: the end; undefined: nowhere). */
  const [rowDrag, setRowDrag] = useState<{ id: number; before: number | null | undefined } | null>(null);
  const dragged = useMemo(
    () => (rowDrag ? new Set([rowDrag.id, ...descendants(plan.tasks, rowDrag.id)]) : null),
    [rowDrag?.id, plan.tasks],
  );

  /**
   * The row number is the handle: a click opens the task, a drag past the slop
   * moves it with everything under it. Alt+↑/↓ does the same from the keyboard.
   */
  const startRowDrag = (e: React.PointerEvent<HTMLButtonElement>, t: Task) => {
    if (e.button !== 0 || saving) return;
    const handle = e.currentTarget;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let moving = false;
    let before: number | null | undefined;
    const landing = (y: number): number | null | undefined => {
      const rows = [...(tableRef.current?.querySelectorAll<HTMLTableRowElement>('tbody tr[data-task]') ?? [])];
      const below = rows.find((tr) => { const r = tr.getBoundingClientRect(); return y < r.top + r.height / 2; });
      const id = below ? Number(below.dataset.task) : null;
      return moveBefore(plan.tasks, t.id, id) ? id : undefined;
    };
    const move = (ev: PointerEvent) => {
      if (!moving) {
        if (Math.hypot(ev.clientX - x0, ev.clientY - y0) < DRAG_SLOP) return;
        moving = true;
        handle.setPointerCapture(ev.pointerId);
      }
      // Near the top or bottom of the table, keep going the way the pointer is heading.
      const pane = tablePaneRef.current?.getBoundingClientRect();
      if (pane && ev.clientY < pane.top + 64) tablePaneRef.current!.scrollBy(0, -16);
      else if (pane && ev.clientY > pane.bottom - 48) tablePaneRef.current!.scrollBy(0, 16);
      before = landing(ev.clientY);
      setRowDrag({ id: t.id, before });
    };
    const stop = (drop: boolean) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('keydown', key, true);
      setRowDrag(null);
      if (!moving) { if (drop) onOpen(t.id); return; }
      if (drop && before !== undefined) void onMoveTo(t, before);
    };
    const up = () => stop(true);
    const cancel = () => stop(false);
    const key = (ev: globalThis.KeyboardEvent) => { if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); moving = true; before = undefined; stop(false); } };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('keydown', key, true);
  };

  const setShow = (k: keyof GanttShow, v: boolean) => setPrefs((p) => ({ ...p, show: { ...p.show, [k]: v } }));
  const hasBaseline = plan.baseline.length > 0;

  return (
    <div className="task-table-wrap">
      <div className="gantt-toolbar" role="toolbar" aria-label="Chart">
        <div className="segmented" role="group" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z} type="button" aria-pressed={prefs.zoom === z} onClick={() => setPrefs((p) => ({ ...p, zoom: z }))}>{ZOOM_LABEL[z]}</button>
          ))}
        </div>
        <button type="button" className="btn quiet" onClick={fit} title="Pick the zoom that shows the whole plan">Fit</button>
        <button type="button" className="btn quiet" onClick={() => setCommand((c) => ({ kind: 'today', n: (c?.n ?? 0) + 1 }))}>Today</button>
        <span className="toolbar-sep" aria-hidden="true" />
        <details className="menu">
          <summary className="btn quiet">Show</summary>
          <div className="menu-list gantt-show" role="group" aria-label="Show on the chart">
            {(Object.keys(SHOW_LABEL) as (keyof GanttShow)[]).map((k) => (
              <label key={k} className="check" title={SHOW_HINT[k]}>
                <input type="checkbox" checked={prefs.show[k]} onChange={(e) => setShow(k, e.target.checked)} />
                <span>{SHOW_LABEL[k]}<small>{SHOW_HINT[k]}</small></span>
              </label>
            ))}
            <label className="check" title="Each task's place in the outline">
              <input type="checkbox" checked={prefs.wbs} onChange={(e) => setPrefs((p) => ({ ...p, wbs: e.target.checked }))} />
              <span>WBS column<small>Each task’s place in the outline, as 1.2.3</small></span>
            </label>
            <label className="check" title="Who does each task">
              <input type="checkbox" checked={prefs.who} onChange={(e) => setPrefs((p) => ({ ...p, who: e.target.checked }))} />
              <span>Who column<small>The people on each task; type names with commas between</small></span>
            </label>
            <label className="check" title="Each task's best and worst case, for the assistant's forecast">
              <input type="checkbox" checked={prefs.estimates} onChange={(e) => setPrefs((p) => ({ ...p, estimates: e.target.checked }))} />
              <span>Best and Worst columns<small>Each task’s range in working days, for the forecast; blank uses the default</small></span>
            </label>
          </div>
        </details>
        {deepest > 0 && (
          <details className="menu">
            <summary className="btn quiet">Outline</summary>
            <div className="menu-list" role="menu" aria-label="Outline">
              <button type="button" role="menuitem" onClick={() => showLevel(null)}>Expand all</button>
              {Array.from({ length: Math.min(deepest, 3) }, (_, i) => (
                <button key={i} type="button" role="menuitem" onClick={() => showLevel(i + 1)}>
                  {i === 0 ? 'Level 1: top-level tasks only' : `Down to level ${i + 1}`}
                </button>
              ))}
            </div>
          </details>
        )}
        <input
          className="gantt-search"
          type="search"
          value={query}
          placeholder="Find a task or person"
          aria-label="Find a task or person"
          onChange={(e) => setQuery(e.target.value)}
        />
        <label className="check">
          <input type="checkbox" checked={criticalOnly} onChange={(e) => setCriticalOnly(e.target.checked)} />
          Critical only
        </label>
        <span className="spacer" />
        {hasBaseline ? (
          <DangerButton label="Clear baseline" confirmLabel="Clear it?" onConfirm={() => void onClearBaseline()} disabled={saving} />
        ) : null}
        <button type="button" className="btn quiet" onClick={() => void onSaveBaseline()} disabled={saving || !plan.tasks.length}
          title="Keep every task’s current dates to compare the plan against later">
          {hasBaseline ? 'Update baseline' : 'Save baseline'}
        </button>
        <details className="menu">
          <summary className="btn quiet">Export</summary>
          <div className="menu-list" role="menu">
            <button type="button" role="menuitem" onClick={onExportCsv}>CSV for spreadsheets</button>
            <button type="button" role="menuitem" onClick={onExportXml}>MS Project XML</button>
            <button type="button" role="menuitem" onClick={() => window.print()}>Print or save as PDF</button>
          </div>
        </details>
        <button type="button" className="btn quiet" onClick={() => fileRef.current?.click()} disabled={saving}
          title="Add tasks from a CSV or MS Project XML file">Import</button>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,.txt,.xml,text/csv,application/xml,text/xml"
          hidden
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (f) void onImport(f);
          }}
        />
      </div>

      <div className={`task-split${plan.tasks.length ? '' : ' is-empty'}`} ref={splitRef}>
      <div
        className={`task-split-table${tableWidth != null && plan.tasks.length ? ' is-sized' : ''}`}
        style={tableWidth != null && plan.tasks.length ? { width: tableWidth } : undefined}
        ref={tablePaneRef}
        onScroll={(e) => followScroll(e.currentTarget)}
      >
      <table className={`task-table${rowDrag ? ' is-reordering' : ''}${prefs.wbs ? ' has-wbs' : ''}${prefs.who ? ' has-who' : ''}`} ref={tableRef}>
        <thead>
          <tr>
            <th scope="col" className="c-row"><span className="visually-hidden">Row</span></th>
            <th scope="col" className="c-code" title="The task's ID, which After refers to. Moving a row never changes it.">ID</th>
            {prefs.wbs && <th scope="col" className="c-wbs" title="The task's place in the outline">WBS</th>}
            <th scope="col" className="c-name">Task</th>
            <th scope="col" className="c-env">Environment</th>
            <th scope="col" className="c-num">Days</th>
            {prefs.estimates && (
              <>
                <th scope="col" className="c-num c-est" title="Best case in working days. Blank uses 10% under the plan; the grey number shows it.">Best</th>
                <th scope="col" className="c-num c-est" title="Worst case in working days. Blank uses 30% over the plan; the grey number shows it.">Worst</th>
              </>
            )}
            <th scope="col" className="c-after" title="IDs of the tasks this one waits for. 2+3 means three working days after task 2 ends; 2SS starts with it, 2FF finishes with it.">After</th>
            {prefs.who && <th scope="col" className="c-who" title="Who does the task, with commas between names. A new name adds that person; a summary's people are its owners.">Who</th>}
            <th scope="col" className="c-date">Start</th>
            <th scope="col" className="c-date">Finish</th>
            <th scope="col" className="c-num">Float</th>
            <th scope="col" className="c-status">Status</th>
          </tr>
        </thead>
        <tbody>
          {plan.tasks.map((t) => {
            if (!visible.has(t.id)) return null;
            const s = schedule.get(t.id);
            const o = outlineRows.get(t.id);
            const summary = !!o?.summary;
            const env = environments.find((e) => e.id === t.environment_id);
            const late = !summary && overdue.has(t.id) && s;
            const leaves = summary ? leavesOf(plan.tasks, t.id).map((id) => plan.tasks.find((x) => x.id === id)!) : [];
            const blocked = leaves.filter((x) => x.status === 'blocked').length;
            const done = leaves.filter((x) => x.status === 'done').length;
            return (
              <tr
                key={t.id}
                data-task={t.id}
                className={`${s?.critical ? 'is-critical' : ''}${t.status === 'done' && !summary ? ' is-done' : ''}${summary ? ' is-summary' : ''}${
                  dragged?.has(t.id) ? ' is-dragged' : ''}${rowDrag && rowDrag.before === t.id ? ' is-drop-before' : ''}${lit.has(t.id) ? ' is-spotlit' : ''}`}
                style={{ ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'transparent', ['--depth' as string]: o?.depth ?? 0 } as CSSProperties}
                onKeyDown={(e) => rowKeys(e, t)}
              >
                <td className="c-row">
                  <button
                    type="button"
                    className="row-num"
                    // Pointer clicks are told from drags in startRowDrag; this is Enter and Space.
                    onClick={(e) => { if (e.detail === 0) onOpen(t.id); }}
                    onPointerDown={(e) => startRowDrag(e, t)}
                    aria-label={`Open ${t.name}`}
                    title={`Open task ${o?.wbs ?? ''}. Drag to move it.`}
                  >
                    {rowOf.get(t.id)}
                  </button>
                </td>
                <td className="c-code" data-label="ID">
                  <CellInput
                    field="code"
                    label="Task ID"
                    inputMode="numeric"
                    value={String(codeOf.get(t.id) ?? '')}
                    onCommit={(v) => {
                      const n = checkCode(v, t.id);
                      if (n == null) return false;
                      return n !== t.code ? onUpdate(t, { code: n }) : undefined;
                    }}
                  />
                </td>
                {prefs.wbs && <td className="c-wbs" data-label="WBS">{o?.wbs}</td>}
                <td className="c-name">
                  <div className="name-cell">
                  {summary ? (
                    <button
                      type="button"
                      className="outline-toggle"
                      aria-expanded={!collapsed.has(t.id)}
                      aria-label={`${collapsed.has(t.id) ? 'Show' : 'Hide'} the tasks under ${t.name}`}
                      onClick={() => toggle(t.id)}
                    >
                      <svg viewBox="0 0 10 10" aria-hidden="true"><path d={collapsed.has(t.id) ? 'M3 1.5 7 5 3 8.5z' : 'M1.5 3 5 7 8.5 3z'} /></svg>
                    </button>
                  ) : <span className="outline-toggle is-leaf" aria-hidden="true" />}
                  <CellInput
                    field="name"
                    label="Task name"
                    value={t.name}
                    onCommit={(v) => (v.trim() && v.trim() !== t.name ? onUpdate(t, { name: v.trim() }) : undefined)}
                    onEnter={() => {
                      if (rowOf.get(t.id) === plan.tasks.length) addRef.current?.focus();
                    }}
                  />
                  {summary && (
                    <span className="task-count" title={`${done} of ${leaves.length} done`}>
                      {leaves.length} task{leaves.length === 1 ? '' : 's'}{blocked ? `, ${blocked} blocked` : ''}
                    </span>
                  )}
                  <button
                    type="button"
                    className="add-sub"
                    disabled={saving}
                    onClick={() => void onAddSub(t)}
                    aria-label={`Add a sub-task under ${t.name}`}
                    title={summary ? `Add a sub-task under ${t.name}` : `Add a sub-task: ${t.name} becomes a summary of the tasks under it`}
                  >
                    <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5v7M1.5 5h7" /></svg>
                  </button>
                  </div>
                </td>
                <td className="c-env" data-label="Environment">
                  {summary ? <span className="cell-quiet" title="A summary books nothing; its tasks do">—</span> : (
                    <select
                      data-field="env"
                      aria-label="Environment"
                      value={t.environment_id ?? ''}
                      onChange={(e) => void onUpdate(t, { environment_id: e.target.value ? Number(e.target.value) : null })}
                    >
                      <option value="">None</option>
                      {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                    </select>
                  )}
                </td>
                <td className="c-num" data-label="Days">
                  {summary ? (
                    <span className="cell-quiet" title="Working days from its first task’s start to its last task’s finish">
                      {s ? workingDays(s.start, s.end, holidays) : '—'}
                    </span>
                  ) : (
                    <CellInput
                      field="duration"
                      label="Working days"
                      inputMode="numeric"
                      value={String(t.duration)}
                      onCommit={(v) => {
                        const n = Number(v);
                        if (!Number.isInteger(n) || n < 0) { onError('Days is a whole number of working days; 0 makes a milestone.'); return false; }
                        return n !== t.duration ? onUpdate(t, { duration: n }) : undefined;
                      }}
                    />
                  )}
                </td>
                {prefs.estimates && (
                  <>
                    <td className="c-num c-est" data-label="Best">
                      {summary ? <span className="cell-quiet">—</span> : (
                        <EstimateCell task={t} end="duration_low" onError={onError} onUpdate={onUpdate} />
                      )}
                    </td>
                    <td className="c-num c-est" data-label="Worst">
                      {summary ? <span className="cell-quiet">—</span> : (
                        <EstimateCell task={t} end="duration_high" onError={onError} onUpdate={onUpdate} />
                      )}
                    </td>
                  </>
                )}
                <td className="c-after" data-label="After">
                  <AfterCell
                    value={formatPredecessors(plan.dependencies, t.id, codeOf)}
                    choices={choices}
                    ownId={t.id}
                    onCommit={(v) => {
                      const parsed = parseAfter(v, idOfCode, t.id);
                      if (!parsed.ok) { onError(parsed.error); return false; }
                      if (v.trim() === formatPredecessors(plan.dependencies, t.id, codeOf)) return undefined;
                      return onUpdate(t, { predecessors: parsed.links });
                    }}
                  />
                </td>
                {prefs.who && (
                  <td className="c-who" data-label={summary ? 'Owner' : 'Who'}>
                    <ResourceCell
                      value={formatResources(t.resource_ids, people)}
                      resources={plan.resources}
                      label={summary ? `Owner of ${t.name}` : `Who does ${t.name}`}
                      onCommit={(v) => {
                        const parsed = parseResources(v);
                        if (!parsed.ok) { onError(parsed.error); return false; }
                        if (parsed.names.join(', ') === formatResources(t.resource_ids, people)) return undefined;
                        return onUpdate(t, { resources: parsed.names.join(', ') });
                      }}
                    />
                  </td>
                )}
                <td className="c-date" data-label="Start">
                  {!s ? '—' : summary ? <span className="cell-quiet">{formatDate(s.start)}</span>
                    : <DateCell field="start" label={`Start of ${t.name}`} value={s.start} onCommit={(d) => onSetStart(t, d)} />}
                </td>
                <td className="c-date" data-label="Finish">
                  {!s ? '—' : summary ? <span className="cell-quiet">{formatDate(s.end)}</span>
                    : <DateCell field="finish" label={`Finish of ${t.name}`} value={s.end} onCommit={(d) => onSetFinish(t, d)} />}
                </td>
                <td className="c-num c-float" data-label="Float">
                  {s ? (s.critical ? <strong>critical</strong> : `${s.total_float}d`) : '—'}
                </td>
                <td className="c-status" data-label="Status">
                  {summary ? (
                    <span className="status-cell cell-quiet" title="Rolled up from its tasks">
                      <span className="status-glyph" aria-hidden="true">{STATUS_GLYPH[t.status]}</span>
                      {STATUS_LABEL[t.status]}{progress.get(t.id) ? `, ${progress.get(t.id)}%` : ''}
                    </span>
                  ) : (
                    <div className="status-row">
                      <label className="status-cell">
                        <span className="status-glyph" aria-hidden="true">{STATUS_GLYPH[t.status]}</span>
                        <select
                          data-field="status"
                          aria-label="Status"
                          value={t.status}
                          onChange={(e) => void onUpdate(t, { status: e.target.value as TaskStatus })}
                        >
                          {STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}
                        </select>
                      </label>
                      {late && <OverdueFlag text={`Should have started on ${formatDate(s!.start)}`} />}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
          <tr className={`task-add${rowDrag && rowDrag.before === null ? ' is-drop-before' : ''}`}>
            <td className="c-row"><span className="row-num is-new" aria-hidden="true">+</span></td>
            <td className="c-code">
              <input
                value={codeDraft ?? String(nextCode)}
                disabled={saving}
                inputMode="numeric"
                aria-label="ID of the new task"
                title="The new task's ID; the next free number is filled in"
                onChange={(e) => setCodeDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addRef.current?.focus(); } }}
              />
            </td>
            <td colSpan={8 + (prefs.wbs ? 1 : 0) + (prefs.estimates ? 2 : 0)}>
              <input
                ref={addRef}
                value={draft}
                disabled={saving}
                aria-label="Add a task"
                placeholder={plan.tasks.length ? 'Add a task' : 'Add the first task, then press Enter'}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void submitNew(); }}
                autoFocus={!plan.tasks.length}
              />
            </td>
          </tr>
        </tbody>
      </table>
      {strip && prefs.show.strip && plan.tasks.length > 0 && (
        <div className="strip-labels" style={{ ['--strip-head' as string]: `${STRIP_HEAD}px`, ['--strip-lane' as string]: `${STRIP_LANE}px` } as CSSProperties}>
          <div className="strip-labels-head">Environments, whole team</div>
          {strip.environments.map((e) => (
            <div key={e.id} className="strip-labels-row" style={{ ['--env-color' as string]: ENV_COLOR[e.kind] } as CSSProperties}>
              {e.name}<span>room for {e.capacity}</span>
            </div>
          ))}
        </div>
      )}
      </div>
      {plan.tasks.length > 0 && (
        <div
          className="split-handle"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize table and chart"
          aria-valuenow={tableWidth ?? TABLE_WIDTH}
          aria-valuemin={SPLIT_MIN_TABLE}
          tabIndex={0}
          title="Drag to resize. Double-click to show the whole table."
          onPointerDown={startSplitDrag}
          onDoubleClick={() => setTableWidth(null)}
          onKeyDown={splitKeys}
        />
      )}
      {plan.tasks.length > 0 && (
        <div className="task-split-chart" ref={chartPaneRef} onScroll={(e) => followScroll(e.currentTarget)}>
        <Gantt
          tasks={plan.tasks}
          outline={outlineRows}
          deps={plan.dependencies}
          schedule={schedule}
          environments={environments}
          holidays={holidays}
          today={today}
          start={plan.project.start_date ?? null}
          target={plan.project.target_date ?? null}
          rows={geometry.rows}
          head={geometry.head}
          height={geometry.height}
          zoom={prefs.zoom}
          show={prefs.show}
          baseline={baseline}
          bookings={plan.bookings}
          progress={progress}
          people={people}
          strip={strip}
          command={command}
          preview={preview}
          onOpen={onOpen}
          onSetStart={onSetStart}
          onSetFinish={onSetFinish}
          onLink={onLink}
          onLinkChange={onLinkChange}
          onRelease={onRelease}
        />
        </div>
      )}
      </div>
      <p className="table-hint">
        {hiddenCount > 0 && <><strong>{hiddenCount} row{hiddenCount === 1 ? '' : 's'} hidden</strong> by the filter or a closed summary. </>}
        Enter moves on, drag a row number or press Alt+↑/↓ to reorder, Alt+Shift+→/← puts a task under the one above or takes it out.
        In After, write task IDs (type a number or part of a name to pick one):
        {' '}<kbd>2</kbd>, <kbd>2+3</kbd> to wait three working days, <kbd>2SS</kbd> to start with it, <kbd>2FF</kbd> to finish with it.
        In Who, write names with commas between (<kbd>Mai, Tuan</kbd>); a new name adds that person.
        On the chart, drag a bar to move it, its right end to change its length, or the dot after it onto another task to link them.
      </p>
    </div>
  );
}

/** The table's natural width in the split; keep in step with `.task-split .task-table`. */
const TABLE_WIDTH = 932;
/** How far a row number travels before a press becomes a drag, as for booking bars. */
const DRAG_SLOP = 4;
/** Row number and task name: never hide those. */
const SPLIT_MIN_TABLE = 240;
const SPLIT_MIN_CHART = 160;
const SPLIT_KEY = 'plan.tableWidth';
const ASSISTANT_KEY = 'plan.assistant';

function readAssistantOpen(): boolean {
  try { return localStorage.getItem(ASSISTANT_KEY) === '1'; } catch { return false; }
}

function readSplit(): number | null {
  try {
    const n = Number(localStorage.getItem(SPLIT_KEY));
    return Number.isFinite(n) && n >= SPLIT_MIN_TABLE ? n : null;
  } catch {
    return null;
  }
}

function sameRows(a: ReadonlyMap<number, RowBox>, b: ReadonlyMap<number, RowBox>): boolean {
  if (a.size !== b.size) return false;
  for (const [id, r] of a) {
    const q = b.get(id);
    if (!q || q.top !== r.top || q.height !== r.height) return false;
  }
  return true;
}

/**
 * An input that commits on Enter or blur and reverts on Escape. `onCommit`
 * returning false keeps the typed value for fixing; undefined means nothing changed.
 */
/**
 * A task that should have started: a warning mark in ink (red is spent on
 * double-bookings) whose words show on hover, on focus, or on a tap or click.
 * The tip is fixed to the viewport, so a clipped table cell cannot cut it off.
 */
function OverdueFlag({ text }: { text: string }) {
  const ref = useRef<HTMLButtonElement>(null);
  const tipId = useId();
  const [pinned, setPinned] = useState(false);
  const [hover, setHover] = useState(false);
  const [at, setAt] = useState<{ x: number; y: number } | null>(null);
  const open = pinned || hover;

  useLayoutEffect(() => {
    if (!open || !ref.current) { setAt(null); return; }
    const r = ref.current.getBoundingClientRect();
    setAt({ x: Math.min(r.left + r.width / 2, window.innerWidth - 110), y: r.bottom + 6 });
  }, [open]);
  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => { if (!ref.current?.contains(e.target as Node)) setPinned(false); };
    const scroll = () => setPinned(false);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('scroll', scroll, true);
    return () => { window.removeEventListener('pointerdown', away, true); window.removeEventListener('scroll', scroll, true); };
  }, [pinned]);

  return (
    <>
      <button
        ref={ref}
        type="button"
        className="overdue-flag"
        aria-label={text}
        aria-describedby={open ? tipId : undefined}
        aria-expanded={pinned}
        onClick={() => setPinned((p) => !p)}
        onPointerEnter={(e) => { if (e.pointerType === 'mouse') setHover(true); }}
        onPointerLeave={() => setHover(false)}
        onFocus={() => setHover(true)}
        onBlur={() => { setHover(false); setPinned(false); }}
        onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); setPinned(false); setHover(false); } }}
      >
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path className="overdue-flag-shape" d="M8 1.8 15 14.2H1z" />
          <path className="overdue-flag-mark" d="M8 6v4M8 11.9v.2" />
        </svg>
      </button>
      {open && at && (
        <span id={tipId} role="tooltip" className="overdue-tip" style={{ left: at.x, top: at.y }}>{text}</span>
      )}
    </>
  );
}

/** A best or worst case, blank for the default range, which shows grey as the placeholder. */
function EstimateCell({ task: t, end, onError, onUpdate }: {
  task: Task;
  end: 'duration_low' | 'duration_high';
  onError: (msg: string | null) => void;
  onUpdate: (t: Task, fields: TaskInput) => Promise<boolean>;
}) {
  const range = rangeOf({ duration: t.duration });
  const word = end === 'duration_low' ? 'Best' : 'Worst';
  const stored = t[end] ?? null;
  return (
    <CellInput
      field={end}
      label={`${word} case for ${t.name}, in working days`}
      inputMode="numeric"
      value={stored == null ? '' : String(stored)}
      placeholder={String(Math.round(end === 'duration_low' ? range.low : range.high))}
      onCommit={(v) => {
        const n = v.trim() === '' ? null : Number(v);
        const low = end === 'duration_low' ? n : t.duration_low ?? null;
        const high = end === 'duration_high' ? n : t.duration_high ?? null;
        const error = n != null && !Number.isInteger(n) ? `${word} is a whole number of working days` : estimateError(t.duration, low, high);
        if (error) { onError(error); return false; }
        return n !== stored ? onUpdate(t, { [end]: n }) : undefined;
      }}
    />
  );
}

function CellInput({
  field, label, value, placeholder, inputMode, onCommit, onEnter,
}: {
  field: string;
  label: string;
  value: string;
  placeholder?: string;
  inputMode?: 'numeric';
  onCommit: (v: string) => Promise<boolean> | boolean | undefined;
  onEnter?: () => void;
}) {
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const committing = useRef(false);
  useEffect(() => { setText(value); setInvalid(false); }, [value]);

  const commit = async () => {
    if (committing.current || text === value) return;
    committing.current = true;
    const result = await onCommit(text);
    committing.current = false;
    if (result === false) setInvalid(true);
    else if (result === undefined) setText(value);
  };

  return (
    <input
      data-field={field}
      aria-label={label}
      aria-invalid={invalid || undefined}
      value={text}
      placeholder={placeholder}
      inputMode={inputMode}
      onChange={(e) => { setText(e.target.value); setInvalid(false); }}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit().then(() => onEnter?.()); }
        if (e.key === 'Escape') { setText(value); setInvalid(false); }
      }}
    />
  );
}

/**
 * After, with the task list at hand: typing a number or part of a name offers
 * the matching TaskIDs; ↑/↓ choose, Enter takes one, Escape closes the list.
 * The list is fixed to the viewport so the table's clipped cells cannot cut it off.
 */
function AfterInput({
  value, onValue, choices, ownId, label, placeholder, invalid, field, onEnter, onEscape, onBlur,
}: {
  value: string;
  onValue: (v: string) => void;
  choices: readonly { id: number; code: number; name: string }[];
  ownId: number;
  label: string;
  placeholder?: string;
  invalid?: boolean;
  field?: string;
  onEnter?: () => void;
  onEscape?: () => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState(0);
  const found = useMemo(() => afterSuggestions(value, caret, choices, ownId), [value, caret, choices, ownId]);
  const shown = open && found.items.length > 0;
  const at = shown ? ref.current?.getBoundingClientRect() : undefined;

  // The list sits where the input was; once the page scrolls, it is simply closed.
  // The input's own text scrolling sideways in a narrow cell does not count.
  useEffect(() => {
    if (!shown) return;
    const close = (e: Event) => { if (e.target !== ref.current) setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [shown]);

  const pick = (code: number) => {
    const next = applySuggestion(value, found.from, found.to, code);
    onValue(next.text);
    setOpen(false);
    requestAnimationFrame(() => { ref.current?.setSelectionRange(next.caret, next.caret); setCaret(next.caret); });
  };

  return (
    <>
      <input
        ref={ref}
        data-field={field}
        aria-label={label}
        aria-invalid={invalid || undefined}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onValue(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setOpen(true); setActive(0); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onBlur={() => { setOpen(false); onBlur?.(); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            if (!shown) { setCaret(e.currentTarget.selectionStart ?? 0); setOpen(true); setActive(0); } else setActive((i) => (i + 1) % found.items.length);
          } else if (e.key === 'ArrowUp' && shown && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            setActive((i) => (i - 1 + found.items.length) % found.items.length);
          } else if (e.key === 'Enter' && shown) {
            e.preventDefault();
            e.stopPropagation();
            pick(found.items[Math.min(active, found.items.length - 1)].code);
          } else if (e.key === 'Escape' && shown) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.();
          } else if (e.key === 'Escape') {
            onEscape?.();
          }
        }}
      />
      {shown && at && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`Tasks for ${label}`}
          className="after-suggest"
          style={{ top: at.bottom + 2, left: at.left, minWidth: Math.max(at.width, 220) }}
        >
          {found.items.map((item, i) => (
            <li
              key={item.code}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => { e.preventDefault(); pick(item.code); }}
              onPointerEnter={() => setActive(i)}
            >
              <span className="after-suggest-code">{item.code}</span>
              <span className="after-suggest-name">{item.name}</span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The After cell: the table's commit-on-leave editing, over AfterInput. */
function AfterCell({ value, choices, ownId, onCommit }: {
  value: string;
  choices: readonly { id: number; code: number; name: string }[];
  ownId: number;
  onCommit: (v: string) => Promise<boolean> | boolean | undefined;
}) {
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const committing = useRef(false);
  useEffect(() => { setText(value); setInvalid(false); }, [value]);

  const commit = async () => {
    if (committing.current || text === value) return;
    committing.current = true;
    const result = await onCommit(text);
    committing.current = false;
    if (result === false) setInvalid(true);
    else if (result === undefined) setText(value);
  };

  return (
    <AfterInput
      field="after"
      label="After tasks"
      value={text}
      onValue={(v) => { setText(v); setInvalid(false); }}
      choices={choices}
      ownId={ownId}
      placeholder="—"
      invalid={invalid}
      onBlur={() => void commit()}
      onEnter={() => void commit()}
      onEscape={() => { setText(value); setInvalid(false); }}
    />
  );
}

/**
 * Who, with everyone at hand: the name under the caret offers the people who
 * match it, and a name nobody has yet shows as new, with the known person it is
 * probably a slip for first (`Tuấn` typed where `Tuan` exists).
 */
function ResourceInput({
  value, onValue, resources, label, placeholder, invalid, field, onEnter, onEscape, onBlur,
}: {
  value: string;
  onValue: (v: string) => void;
  resources: readonly Resource[];
  label: string;
  placeholder?: string;
  invalid?: boolean;
  field?: string;
  onEnter?: () => void;
  onEscape?: () => void;
  onBlur?: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [caret, setCaret] = useState(0);
  const found = useMemo(() => resourceSuggestions(value, caret, resources), [value, caret, resources]);
  const shown = open && found.items.length > 0;
  const at = shown ? ref.current?.getBoundingClientRect() : undefined;

  useEffect(() => {
    if (!shown) return;
    const close = (e: Event) => { if (e.target !== ref.current) setOpen(false); };
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => { window.removeEventListener('scroll', close, true); window.removeEventListener('resize', close); };
  }, [shown]);

  const pick = (item: ResourceSuggestion) => {
    const next = applyResourcePick(value, found.from, found.to, item.kind === 'known' ? item.resource.name : item.name);
    onValue(next.text);
    setOpen(false);
    requestAnimationFrame(() => { ref.current?.setSelectionRange(next.caret, next.caret); setCaret(next.caret); });
  };

  return (
    <>
      <input
        ref={ref}
        data-field={field}
        aria-label={label}
        aria-invalid={invalid || undefined}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown ? `${listId}-${active}` : undefined}
        autoComplete="off"
        value={value}
        placeholder={placeholder}
        onChange={(e) => { onValue(e.target.value); setCaret(e.target.selectionStart ?? e.target.value.length); setOpen(true); setActive(0); }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart ?? 0)}
        onBlur={() => { setOpen(false); onBlur?.(); }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            if (!shown) { setCaret(e.currentTarget.selectionStart ?? 0); setOpen(true); setActive(0); } else setActive((i) => (i + 1) % found.items.length);
          } else if (e.key === 'ArrowUp' && shown && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            setActive((i) => (i - 1 + found.items.length) % found.items.length);
          } else if (e.key === 'Enter' && shown) {
            e.preventDefault();
            e.stopPropagation();
            pick(found.items[Math.min(active, found.items.length - 1)]);
          } else if (e.key === 'Escape' && shown) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          } else if (e.key === 'Enter') {
            e.preventDefault();
            onEnter?.();
          } else if (e.key === 'Escape') {
            onEscape?.();
          }
        }}
      />
      {shown && at && (
        <ul
          id={listId}
          role="listbox"
          aria-label={`People for ${label}`}
          className="after-suggest"
          style={{ top: at.bottom + 2, left: at.left, minWidth: Math.max(at.width, 220) }}
        >
          {found.items.map((item, i) => (
            <li
              key={item.kind === 'known' ? item.resource.id : `new:${item.name}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onPointerDown={(e) => { e.preventDefault(); pick(item); }}
              onPointerEnter={() => setActive(i)}
            >
              {item.kind === 'known' ? (
                <span className="after-suggest-name">{item.resource.name}</span>
              ) : (
                <>
                  <span className="after-suggest-code" aria-hidden="true">＋</span>
                  <span className="after-suggest-name">New: {item.name}</span>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** The Who cell: the table's commit-on-leave editing, over ResourceInput. */
function ResourceCell({ value, resources, label, onCommit }: {
  value: string;
  resources: readonly Resource[];
  label: string;
  onCommit: (v: string) => Promise<boolean> | boolean | undefined;
}) {
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const committing = useRef(false);
  useEffect(() => { setText(value); setInvalid(false); }, [value]);

  const commit = async () => {
    if (committing.current || text === value) return;
    committing.current = true;
    const result = await onCommit(text);
    committing.current = false;
    if (result === false) setInvalid(true);
    else if (result === undefined) setText(value);
  };

  return (
    <ResourceInput
      field="who"
      label={label}
      value={text}
      onValue={(v) => { setText(v); setInvalid(false); }}
      resources={resources}
      placeholder="—"
      invalid={invalid}
      onBlur={() => void commit()}
      onEnter={() => void commit()}
      onEscape={() => { setText(value); setInvalid(false); }}
    />
  );
}

/**
 * A scheduled date you can overwrite. The picker commits at once; typing waits
 * until the date is whole (a four-digit year) and the caret has rested, so a
 * half-typed year never reschedules the plan.
 */
function DateCell({ field, label, value, onCommit }: {
  field: string;
  label: string;
  value: ISODate;
  onCommit: (d: ISODate) => Promise<boolean>;
}) {
  const [text, setText] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const committing = useRef(false);
  // The schedule may not land where you typed (a weekend, a later predecessor), and
  // then `value` does not change; the cell must still show the date that holds.
  const latest = useRef(value);
  latest.current = value;
  useEffect(() => { setText(value); }, [value]);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const commit = async (d: string) => {
    if (timer.current) clearTimeout(timer.current);
    if (committing.current || d === value || !isValidISODate(d) || d < '2000-01-01') return;
    committing.current = true;
    await onCommit(d);
    committing.current = false;
    setText(latest.current);
  };

  return (
    <input
      type="date"
      data-field={field}
      aria-label={label}
      value={text}
      onChange={(e) => {
        const d = e.target.value;
        setText(d);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => void commit(d), 700);
      }}
      onBlur={() => void commit(text)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') { e.preventDefault(); void commit(text); }
        if (e.key === 'Escape') { if (timer.current) clearTimeout(timer.current); setText(value); }
      }}
    />
  );
}

// ---------------------------------------------------------------- task editor

function TaskEditor({
  task, plan, rowOf, codeOf, outlineRows, schedule, environments, envName, saving, today, holidays, onClose, onSave, onDelete, onAddSub,
}: {
  task: Task;
  plan: PlanData;
  rowOf: ReadonlyMap<number, number>;
  codeOf: ReadonlyMap<number, number>;
  outlineRows: ReadonlyMap<number, OutlineRow>;
  today: ISODate;
  holidays: ReadonlySet<ISODate>;
  schedule?: TaskSchedule;
  environments: readonly Environment[];
  envName: (id: number | null) => string | undefined;
  saving: boolean;
  onClose: () => void;
  onSave: (fields: TaskInput) => void;
  onDelete: (bridge: boolean, children: 'lift' | 'delete') => void;
  onAddSub: () => void;
}) {
  const [name, setName] = useState(task.name);
  const [envId, setEnvId] = useState<number | null>(task.environment_id);
  const [duration, setDuration] = useState(String(task.duration));
  const [after, setAfter] = useState(formatPredecessors(plan.dependencies, task.id, codeOf));
  const [codeText, setCodeText] = useState(String(codeOf.get(task.id) ?? ''));
  const [notBefore, setNotBefore] = useState(task.not_before ?? '');
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [actualStart, setActualStart] = useState(task.actual_start ?? '');
  const [actualEnd, setActualEnd] = useState(task.actual_end ?? '');
  const people = useMemo(() => new Map(plan.resources.map((r) => [r.id, r])), [plan.resources]);
  const [who, setWho] = useState(() => formatResources(task.resource_ids, people));
  const [note, setNote] = useState(task.note ?? '');
  const [parentId, setParentId] = useState<number | null>(task.parent_id ?? null);
  const [progressText, setProgressText] = useState(task.progress == null ? '' : String(task.progress));
  const [bestText, setBestText] = useState(task.duration_low == null ? '' : String(task.duration_low));
  const [worstText, setWorstText] = useState(task.duration_high == null ? '' : String(task.duration_high));
  const summary = !!outlineRows.get(task.id)?.summary;
  const under = useMemo(() => descendants(plan.tasks, task.id), [plan.tasks, task.id]);
  const progressN = progressText.trim() === '' ? null : Number(progressText);
  const progressOk = progressN == null || (Number.isInteger(progressN) && progressN >= 0 && progressN <= 100);
  const [bridge, setBridge] = useState(true);
  /** What deleting a summary does with its tasks: the standard takes the branch with it. */
  const [children, setChildren] = useState<'lift' | 'delete'>('delete');
  const [deleteImpact, setDeleteImpact] = useState<PlanImpact | null>(null);
  const [editImpact, setEditImpact] = useState<PlanImpact | null>(null);

  const idOfCode = useMemo(() => taskIdsByCode(plan.tasks), [plan.tasks]);
  const choices = useMemo(() => plan.tasks.map((t) => ({ id: t.id, code: codeOf.get(t.id)!, name: t.name })), [plan.tasks, codeOf]);
  const parsed = parseAfter(after, idOfCode, task.id);
  const code = Number(codeText.trim());
  const codeHolder = idOfCode.get(code);
  const codeError = !Number.isInteger(code) || code < 1 || code > TASK_CODE_MAX ? `A whole number, 1 to ${TASK_CODE_MAX}.`
    : codeHolder != null && codeHolder !== task.id ? `Already ${plan.tasks.find((x) => x.id === codeHolder)?.name}.` : null;
  const days = Number(duration);
  const whoParsed = parseResources(who);
  const best = bestText.trim() === '' ? null : Number(bestText);
  const worst = worstText.trim() === '' ? null : Number(worstText);
  const estimateProblem = summary || !Number.isInteger(days) ? null : estimateError(days, best, worst);
  const valid = name.trim() && Number.isInteger(days) && days >= 0 && parsed.ok && progressOk && !codeError && whoParsed.ok && !estimateProblem;

  /** Only what changed goes to the server, so undo and the audit log stay precise. */
  const fields = useMemo<TaskInput>(() => {
    const f: TaskInput = {};
    if (name.trim() !== task.name) f.name = name.trim();
    if (envId !== task.environment_id) f.environment_id = envId;
    if (Number.isInteger(days) && days !== task.duration) f.duration = days;
    if (parsed.ok && after.trim() !== formatPredecessors(plan.dependencies, task.id, codeOf)) f.predecessors = parsed.links;
    if (!codeError && code !== task.code) f.code = code;
    if (parentId !== (task.parent_id ?? null)) f.parent_id = parentId;
    if (progressOk && progressN !== (task.progress ?? null)) f.progress = progressN;
    if ((notBefore || null) !== task.not_before) f.not_before = notBefore || null;
    if (status !== task.status) f.status = status;
    if ((actualStart || null) !== task.actual_start && status !== 'todo') f.actual_start = actualStart || null;
    if ((actualEnd || null) !== task.actual_end && status === 'done') f.actual_end = actualEnd || null;
    if (whoParsed.ok && whoParsed.names.join(', ') !== formatResources(task.resource_ids, people)) f.resources = whoParsed.names.join(', ');
    if ((note.trim() || null) !== task.note) f.note = note.trim() || null;
    if (!summary && !estimateProblem) {
      if (best !== (task.duration_low ?? null)) f.duration_low = best;
      if (worst !== (task.duration_high ?? null)) f.duration_high = worst;
    }
    return f;
  }, [name, envId, days, after, code, codeError, notBefore, status, actualStart, actualEnd, who, note, parentId, progressN, progressOk, task, plan, codeOf, people, best, worst, estimateProblem, summary]);

  const dirty = Object.keys(fields).length > 0;
  const key = JSON.stringify(fields);

  // What saving would do, previewed as the form changes.
  useEffect(() => {
    if (!dirty || !valid) { setEditImpact(null); return; }
    const t = setTimeout(() => {
      api.previewTask(plan.project.id, { op: 'update', id: task.id, fields })
        .then(setEditImpact).catch(() => setEditImpact(null));
    }, 350);
    return () => clearTimeout(t);
  }, [key, dirty, valid]);

  // What deleting would do, stated before the button is armed.
  useEffect(() => {
    api.previewTask(plan.project.id, { op: 'delete', id: task.id, bridge, children: summary ? children : undefined })
      .then(setDeleteImpact).catch(() => setDeleteImpact(null));
  }, [task.id, bridge, children, summary, plan.project.id]);

  // With its branch, the links that matter are the ones crossing into and out of it.
  const branch = summary && children === 'delete' ? new Set([task.id, ...under]) : new Set([task.id]);
  const successors = plan.dependencies.filter((d) => branch.has(d.predecessor_id) && !branch.has(d.successor_id)).length;
  const predecessors = plan.dependencies.filter((d) => branch.has(d.successor_id) && !branch.has(d.predecessor_id)).length;

  return (
    <Modal
      title={task.name}
      subtitle={[
        `ID ${codeOf.get(task.id)}, row ${rowOf.get(task.id)}`,
        envName(task.environment_id) ? `on ${envName(task.environment_id)}` : 'no environment',
        schedule ? formatRange(schedule.start, schedule.end) : null,
        schedule ? (schedule.critical ? 'critical' : `${schedule.total_float} days float`) : null,
      ].filter(Boolean).join(', ')}
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <DangerButton
            label={summary && children === 'delete' ? `Delete with ${under.size} sub-task${under.size === 1 ? '' : 's'}` : 'Delete task'}
            confirmLabel={deleteImpact && deleteImpact.risk === 'high' ? 'Delete anyway?' : summary && children === 'delete' ? `Delete all ${under.size + 1}?` : 'Delete it?'}
            onConfirm={() => onDelete(bridge, children)}
            disabled={saving}
          />
          <span className="spacer" />
          <button type="button" className="btn quiet" disabled={saving || dirty} onClick={onAddSub}
            title={dirty ? 'Save or cancel your changes first' : `Add a task under ${task.name}`}>
            Add sub-task
          </button>
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!dirty || !valid || saving || !!editImpact?.cycle} onClick={() => onSave(fields)}>
            Save changes
          </button>
        </>
      }
    >
      <div className="dialog-body task-editor">
        <div className="pair name-pair">
          <label className="stack">
            Task
            <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </label>
          <label className="stack">
            ID
            <input inputMode="numeric" value={codeText} onChange={(e) => setCodeText(e.target.value)} aria-invalid={!!codeError || undefined} />
            {codeError && <span className="field-hint">{codeError}</span>}
          </label>
        </div>
        <label className="stack">
          Part of
          <select value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">Nothing: a top-level task</option>
            {plan.tasks.filter((t) => t.id !== task.id && !under.has(t.id)).map((t) => (
              <option key={t.id} value={t.id}>{outlineRows.get(t.id)?.wbs} {t.name}</option>
            ))}
          </select>
          <span className="field-hint">
            {summary
              ? `A summary: its dates roll up from the ${leavesOf(plan.tasks, task.id).length} task${leavesOf(plan.tasks, task.id).length === 1 ? '' : 's'} under it, and it books nothing.`
              : 'Putting it under a task makes that task a summary, whose own length and environment then stop counting.'}
          </span>
        </label>
        {!summary && (
        <div className="pair">
          <label className="stack">
            Environment
            <select value={envId ?? ''} onChange={(e) => setEnvId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">None: books nothing</option>
              {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </label>
          <label className="stack">
            Working days
            <input inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} aria-invalid={!Number.isInteger(days) || days < 0 || undefined} />
            <span className="field-hint">0 makes it a milestone.</span>
          </label>
        </div>
        )}
        {!summary && (
        <div className="pair">
          <label className="stack">
            Best case
            <input inputMode="numeric" value={bestText} onChange={(e) => setBestText(e.target.value)}
              placeholder={Number.isInteger(days) ? String(Math.round(rangeOf({ duration: days }).low)) : ''}
              aria-invalid={(estimateProblem?.startsWith('Best') ?? false) || undefined} />
            <span className="field-hint">{estimateProblem?.startsWith('Best') ? estimateProblem : 'Working days if it goes well. Only the forecast reads it.'}</span>
          </label>
          <label className="stack">
            Worst case
            <input inputMode="numeric" value={worstText} onChange={(e) => setWorstText(e.target.value)}
              placeholder={Number.isInteger(days) ? String(Math.round(rangeOf({ duration: days }).high)) : ''}
              aria-invalid={(estimateProblem?.startsWith('Worst') ?? false) || undefined} />
            <span className="field-hint">{estimateProblem?.startsWith('Worst') ? estimateProblem : 'Working days if it goes badly. Blank uses the grey default.'}</span>
          </label>
        </div>
        )}
        <div className="pair">
          <label className="stack">
            After tasks
            <AfterInput
              value={after}
              onValue={setAfter}
              choices={choices}
              ownId={task.id}
              label="After tasks"
              placeholder="e.g. 2, 3+1, 4SS"
              invalid={!parsed.ok}
            />
            <span className="field-hint">{parsed.ok ? 'IDs of the tasks it waits for, plus any lag. SS starts with one, FF finishes with it. Type a name to find an ID.' : parsed.error}</span>
          </label>
          <label className="stack">
            Start no earlier than
            <input type="date" value={notBefore} onChange={(e) => setNotBefore(e.target.value)} />
            {summary && <span className="field-hint">Holds every task under it.</span>}
          </label>
        </div>
        <div className="pair">
          {summary ? (
            <div className="stack">
              Status
              <span className="field-static">
                {STATUS_LABEL[task.status]}
                <span className="field-hint">Rolled up from the tasks under it: done when all are, in progress once any has started.</span>
              </span>
            </div>
          ) : (
            <label className="stack">
              Status
              <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
                {STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}
              </select>
            </label>
          )}
          <label className="stack">
            {summary ? 'Owner' : 'Who'}
            <ResourceInput
              value={who}
              onValue={setWho}
              resources={plan.resources}
              label={summary ? 'Owner' : 'Who'}
              placeholder={summary ? 'Who is accountable for it' : 'e.g. Mai, Tuan'}
              invalid={!whoParsed.ok}
            />
            <span className="field-hint">{whoParsed.ok ? 'Names with commas between. A new name adds that person.' : whoParsed.error}</span>
          </label>
        </div>
        {!summary && (
          <label className="stack">
            Progress, %
            <input
              inputMode="numeric"
              value={progressText}
              placeholder={`${progressOf({ ...task, status, progress: null, actual_start: actualStart || task.actual_start }, today, holidays)} worked out from its status`}
              onChange={(e) => setProgressText(e.target.value)}
              aria-invalid={!progressOk || undefined}
            />
            <span className="field-hint">Leave blank to work it out from the status. It draws on the chart; it never moves dates.</span>
          </label>
        )}
        {!summary && status !== 'todo' && status !== 'blocked' && (
          <div className="pair">
            <label className="stack">
              Started
              <input type="date" value={actualStart} onChange={(e) => setActualStart(e.target.value)} />
            </label>
            {status === 'done' && (
              <label className="stack">
                Finished
                <input type="date" value={actualEnd} onChange={(e) => setActualEnd(e.target.value)} />
              </label>
            )}
          </div>
        )}
        <label className="stack">
          Note
          <textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </label>

        {editImpact && dirty && <ImpactList title="Saving would" impact={editImpact} />}

        <div className="delete-impact">
          {summary && (
            <fieldset className="choice">
              <legend>If deleted, its {under.size} sub-task{under.size === 1 ? '' : 's'}</legend>
              <label className="check">
                <input type="radio" name="children" checked={children === 'delete'} onChange={() => setChildren('delete')} />
                Go with it
              </label>
              <label className="check">
                <input type="radio" name="children" checked={children === 'lift'} onChange={() => setChildren('lift')} />
                Stay, moved up a level
              </label>
            </fieldset>
          )}
          {predecessors > 0 && successors > 0 && (
            <label className="check">
              <input type="checkbox" checked={bridge} onChange={(e) => setBridge(e.target.checked)} />
              If deleted, keep the chain: link what it waits for to what waits for it
            </label>
          )}
          {deleteImpact && deleteImpact.risk !== 'low' && <ImpactList title="Deleting it would" impact={deleteImpact} />}
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- impact

/** The consequences of a change, stated as facts. Only a new double-booking uses the alarm colour. */
function impactLines(i: PlanImpact): { text: string; alarm?: boolean }[] {
  const lines: { text: string; alarm?: boolean }[] = [];
  if (i.cycle) return [{ text: `make a loop: ${i.cycle.join(' → ')}` }];
  for (const c of i.conflicts_added) {
    lines.push({ text: `double-book ${c.env_name} with ${c.projects.join(' and ')}, ${formatRange(c.start_date, c.end_date)}`, alarm: true });
  }
  if (i.finish.days) {
    lines.push({ text: `finish the project ${Math.abs(i.finish.days)} day${Math.abs(i.finish.days) === 1 ? '' : 's'} ${i.finish.days > 0 ? 'later' : 'earlier'}, on ${formatDate(i.finish.after!)}` });
  }
  if (i.late_by) lines.push({ text: `leave it ${i.late_by} working day${i.late_by === 1 ? '' : 's'} past its target` });
  for (const u of i.unlinked) lines.push({ text: `leave ${u.name} without that predecessor` });
  const moved = i.moved.filter((m) => !i.unlinked.some((u) => u.id === m.id));
  if (moved.length) {
    lines.push({ text: `move ${moved.slice(0, 3).map((m) => `${m.name} ${m.days > 0 ? '+' : '−'}${Math.abs(m.days)}d`).join(', ')}${moved.length > 3 ? ` and ${moved.length - 3} more` : ''}` });
  }
  for (const b of i.bookings) {
    const span = b.after ? formatRange(b.after.start, b.after.end) : '';
    const was = b.before ? formatRange(b.before.start, b.before.end) : '';
    const text = {
      created: `book ${b.env_name} ${span}`,
      removed: `drop the ${b.env_name} booking of ${was}`,
      longer: `lengthen the ${b.env_name} booking to ${span}`,
      shorter: `shorten the ${b.env_name} booking to ${span}`,
      moved: `move the ${b.env_name} booking to ${span}`,
    }[b.change];
    lines.push({ text });
  }
  for (const c of i.conflicts_cleared) lines.push({ text: `clear the ${c.env_name} double-booking with ${c.projects.join(' and ')}` });
  if (i.critical_added.length) lines.push({ text: `put ${i.critical_added.map((c) => c.name).join(', ')} on the critical path` });
  return lines;
}

/** The same facts after the event: the banner reports what a save did, not what it would do. */
const PAST: Record<string, string> = {
  'double-book': 'double-booked', finish: 'finished', leave: 'left', move: 'moved', book: 'booked', drop: 'dropped',
  lengthen: 'lengthened', shorten: 'shortened', clear: 'cleared', put: 'put', make: 'made',
};
function pastTense(text: string): string {
  const [verb, ...rest] = text.split(' ');
  return [PAST[verb] ?? verb, ...rest].join(' ');
}

function ImpactList({ title, impact }: { title: string; impact: PlanImpact }) {
  const lines = impactLines(impact);
  if (!lines.length) return null;
  return (
    <div className={`impact impact-${impact.risk}`}>
      <p className="impact-title">{title}</p>
      <ul>
        {lines.map((l, i) => <li key={i} className={l.alarm ? 'is-alarm' : ''}>{l.text}</li>)}
      </ul>
    </div>
  );
}

function ImpactBanner({ title, impact, onUndo, onClose }: {
  title: string; impact: PlanImpact; onUndo?: () => void; onClose: () => void;
}) {
  const lines = impactLines(impact);
  return (
    <div className={`impact-banner impact-${impact.risk}`} role="status">
      <div className="impact-banner-text">
        <strong>{title}.</strong>{' '}
        {lines.length ? <>This {lines.map((l, i) => (
          <span key={i} className={l.alarm ? 'is-alarm' : ''}>{i ? '; ' : ''}{pastTense(l.text)}</span>
        ))}.</> : null}
      </div>
      {onUndo && <button type="button" className="btn quiet" onClick={onUndo}>Undo</button>}
      <button type="button" className="link-button" onClick={onClose}>Dismiss</button>
    </div>
  );
}

// ---------------------------------------------------------------- holds

/** The bookings this plan makes or stretches: the bridge back to the board. */
function Holds({ bookings, environments, onRelease }: {
  bookings: readonly BookingView[];
  environments: readonly Environment[];
  onRelease: (b: BookingView) => Promise<void>;
}) {
  const held = bookings.filter((b) => b.auto || b.tasks?.length).sort((a, b) => a.start_date.localeCompare(b.start_date));
  const [releasing, setReleasing] = useState<number | null>(null);
  if (!held.length) {
    return <footer className="holds"><span className="holds-label">Books</span><span className="holds-none">Nothing yet. Give a task an environment and it books it.</span></footer>;
  }
  return (
    <footer className="holds">
      <span className="holds-label">Books</span>
      <ul>
        {held.map((b) => {
          const env = environments.find((e) => e.id === b.environment_id);
          return (
            <li key={b.id} style={{ ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'var(--rule)' } as CSSProperties}>
              <span className="holds-env">{b.env_name}</span>
              <span className="holds-span">{formatRange(b.start_date, b.end_date)}</span>
              <span className="holds-why">
                {b.auto ? 'made by tasks'
                  : b.hold_end && b.end_date > b.hold_end ? 'booked by hand, longer than its tasks'
                  : 'stretched to fit its tasks'}
              </span>
              {b.release_from && (
                <button
                  type="button"
                  className="btn quiet holds-release"
                  disabled={releasing === b.id}
                  onClick={() => { setReleasing(b.id); void onRelease(b).finally(() => setReleasing(null)); }}
                >
                  Tasks done. Release from {formatDate(b.release_from)}
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </footer>
  );
}
