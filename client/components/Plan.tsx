import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { api, type PlanData, type SavedLayout, type TaskChange, type TaskInput } from '../api.ts';
import type {
  BookingView, Environment, ISODate, PlanImpact, Project, Task, TaskSchedule, TaskStatus,
} from '../../shared/types.ts';
import { formatDate, formatRange } from '../layout.ts';
import { isWorkingDay, isValidISODate, workingDays } from '../../shared/dates.ts';
import { formatPredecessors, parsePredecessors } from '../predecessors.ts';
import { ENV_COLOR } from './Board.tsx';
import { DangerButton, Modal } from './Dialogs.tsx';
import { NetworkDiagram } from './NetworkDiagram.tsx';
import { edgeKey, type Route } from '../network.ts';
import type { Arrangement } from '../smartLayout.ts';

/**
 * A project's plan: its tasks, what drives their dates, and the bookings they
 * make. A scheduling instrument rather than a to-do list, so there is no
 * kanban here: a table to enter work fast, and a network to see why the dates
 * are what they are.
 */

const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'To do', in_progress: 'In progress', blocked: 'Blocked', done: 'Done',
};
/** Shape, not colour: red is spent on double-bookings. */
const STATUS_GLYPH: Record<TaskStatus, string> = { todo: '○', in_progress: '◐', blocked: '‖', done: '●' };
const STATUSES: TaskStatus[] = ['todo', 'in_progress', 'blocked', 'done'];

/** Fields that move dates. Changing only a name or a note needs no impact check. */
const SCHEDULE_FIELDS: (keyof TaskInput)[] = [
  'duration', 'environment_id', 'predecessors', 'status', 'not_before', 'actual_start', 'actual_end',
];

type Tab = 'tasks' | 'network';

export function PlanView({
  projectId, projects, environments, holidays, today, onBack, onSwitchProject, onChanged, onRelease,
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
}) {
  const [plan, setPlan] = useState<PlanData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('tasks');
  const [showEnvs, setShowEnvs] = useState(false);
  const [criticalOnly, setCriticalOnly] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  /** What the last change did, with a way to take it back. */
  const [outcome, setOutcome] = useState<{ title: string; impact: PlanImpact; undo?: () => Promise<void> } | null>(null);
  /** A typed date the schedule could not honour exactly, and why. */
  const [notice, setNotice] = useState<string | null>(null);
  const addRef = useRef<HTMLInputElement>(null);
  /** What the last Smart Arrange replaced, until something else moves the layout. */
  const [arrangeUndo, setArrangeUndo] = useState<SavedLayout | null>(null);

  const load = useCallback(async () => {
    try {
      setPlan(await api.plan(projectId));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load the plan');
    }
  }, [projectId]);

  useEffect(() => { setPlan(null); setEditing(null); setOutcome(null); setArrangeUndo(null); void load(); }, [load]);

  const schedule = useMemo(() => new Map((plan?.schedule ?? []).map((s) => [s.id, s])), [plan]);
  const rowOf = useMemo(() => new Map((plan?.tasks ?? []).map((t, i) => [t.id, i + 1])), [plan]);

  /** Apply a server answer: the new plan, and a nudge to the board behind us. */
  const accept = (next: PlanData) => {
    setPlan(next);
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
      const fields = change.op === 'delete' ? null : change.fields;
      const moves = change.op !== 'update' || SCHEDULE_FIELDS.some((f) => fields && f in fields);
      const impact = moves ? await api.previewTask(projectId, change) : null;
      if (impact?.cycle) {
        setError(`That would make a loop: ${impact.cycle.join(' → ')}.`);
        return null;
      }
      let res: { plan: PlanData; id?: number };
      if (change.op === 'create') res = await api.createTask(projectId, { name: 'New task', ...change.fields } as TaskInput & { name: string }, change.after_id);
      else if (change.op === 'update') res = await api.updateTask(change.id, change.fields);
      else res = await api.deleteTask(change.id, !!change.bridge);
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
        back.predecessors = plan!.dependencies.filter((d) => d.successor_id === t.id).map((d) => ({ id: d.predecessor_id, lag: d.lag }));
      } else {
        (back as Record<string, unknown>)[k] = t[k as keyof Task];
      }
    }
    return save({ op: 'update', id: t.id, fields }, title, async () => {
      try { accept((await api.updateTask(t.id, back)).plan); setOutcome(null); } catch (err) { fail(err); }
    });
  };

  /**
   * A typed start. Dates are scheduled, so it becomes the floor the task may not
   * start before (or, once work has begun, the day it actually started). The task
   * keeps its length, so its finish moves with it.
   */
  const setStart = async (t: Task, date: ISODate): Promise<boolean> => {
    const started = (t.status === 'in_progress' || t.status === 'done') && t.actual_start;
    const fields: TaskInput = started ? { actual_start: date } : { not_before: date };
    const next = await updateTask(t, fields, `Moved ${t.name} to start ${formatDate(date)}`);
    const got = next?.schedule.find((x) => x.id === t.id)?.start;
    if (got && got !== date && !started) {
      setNotice(!isWorkingDay(date, holidays)
        ? `${t.name} starts ${formatDate(got)}: ${formatDate(date)} is not a working day.`
        : `${t.name} starts ${formatDate(got)}, not ${formatDate(date)}: a task it comes after finishes later. Clear After to pin it to the date.`);
    }
    return !!next;
  };

  /**
   * A typed finish sets the length: the working days from the start to that day,
   * weekends and holidays left out. A finished task records it as its actual finish.
   */
  const setFinish = async (t: Task, date: ISODate): Promise<boolean> => {
    const start = schedule.get(t.id)?.start;
    if (!start) return false;
    if (date < start) {
      setError(`${t.name} starts ${formatDate(start)}, so it cannot finish before then.`);
      return false;
    }
    let fields: TaskInput;
    if (t.status === 'done') fields = { actual_end: date };
    else if (t.duration === 0) fields = { not_before: date };
    else fields = { duration: Math.max(1, workingDays(start, date, holidays)) };
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

  const addTask = async (name: string) => {
    const last = plan?.tasks[plan.tasks.length - 1];
    return save({ op: 'create', fields: { name }, after_id: last?.id ?? null }, `Added ${name}`);
  };

  const move = async (t: Task, delta: -1 | 1) => {
    if (!plan) return;
    const ids = plan.tasks.map((x) => x.id);
    const i = ids.indexOf(t.id);
    const j = i + delta;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    try { accept((await api.reorderTasks(projectId, ids)).plan); } catch (err) { fail(err); }
  };

  const project = plan?.project ?? projects.find((p) => p.id === projectId);
  const editingTask = editing != null ? plan?.tasks.find((t) => t.id === editing) ?? null : null;
  const criticalCount = plan?.critical_path.length ?? 0;
  const envById = (id: number | null) => environments.find((e) => e.id === id);

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
    if (!plan) return;
    // Keep exactly what is replaced, automatic places included, so Undo is exact.
    setArrangeUndo({
      tasks: plan.tasks.map((t) => ({ id: t.id, x: t.net_x ?? null, y: t.net_y ?? null })),
      dependencies: plan.dependencies.map((d) => ({
        predecessor_id: d.predecessor_id, successor_id: d.successor_id,
        out: d.route_out ?? null, y: d.route_y ?? null, in: d.route_in ?? null, from: d.route_from ?? null, to: d.route_to ?? null,
      })),
    });
    applyLayout({
      tasks: plan.tasks.map((t) => {
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
          </div>
        </div>

        {plan && (
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

      <div className="plan-body">
        {!plan ? (
          <div className="empty"><p>Loading the plan…</p></div>
        ) : tab === 'tasks' ? (
          <TaskTable
            plan={plan}
            schedule={schedule}
            rowOf={rowOf}
            environments={environments}
            today={today}
            saving={saving}
            addRef={addRef}
            onUpdate={(t, f) => updateTask(t, f).then(Boolean)}
            onSetStart={setStart}
            onSetFinish={setFinish}
            onAdd={(name) => addTask(name).then(Boolean)}
            onMove={move}
            onOpen={setEditing}
            onError={setError}
          />
        ) : plan.tasks.length ? (
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
              tasks={plan.tasks}
              deps={plan.dependencies}
              schedule={schedule}
              order={plan.order}
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

      {plan && <Holds bookings={plan.bookings} environments={environments} onRelease={async (b) => { await onRelease(b); await load(); }} />}

      {editingTask && plan && (
        <TaskEditor
          task={editingTask}
          plan={plan}
          rowOf={rowOf}
          schedule={schedule.get(editingTask.id)}
          environments={environments}
          envName={(id) => envById(id)?.name}
          saving={saving}
          onClose={() => setEditing(null)}
          onSave={async (fields) => { if (await updateTask(editingTask, fields)) setEditing(null); }}
          onDelete={async (bridge) => {
            if (await save({ op: 'delete', id: editingTask.id, bridge }, `Deleted ${editingTask.name}`)) setEditing(null);
          }}
        />
      )}
    </section>
  );
}

// ---------------------------------------------------------------- task table

function TaskTable({
  plan, schedule, rowOf, environments, today, saving, addRef, onUpdate, onSetStart, onSetFinish, onAdd, onMove, onOpen, onError,
}: {
  plan: PlanData;
  schedule: ReadonlyMap<number, TaskSchedule>;
  rowOf: ReadonlyMap<number, number>;
  environments: readonly Environment[];
  today: ISODate;
  saving: boolean;
  addRef: React.RefObject<HTMLInputElement>;
  onUpdate: (t: Task, fields: TaskInput) => Promise<boolean>;
  onSetStart: (t: Task, date: ISODate) => Promise<boolean>;
  onSetFinish: (t: Task, date: ISODate) => Promise<boolean>;
  onAdd: (name: string) => Promise<boolean>;
  onMove: (t: Task, delta: -1 | 1) => Promise<void>;
  onOpen: (id: number) => void;
  onError: (msg: string | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const tableRef = useRef<HTMLTableElement>(null);

  /** Alt+arrows reorder the row under the caret, and keep it there. */
  const rowKeys = (e: KeyboardEvent, t: Task) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const field = (e.target as HTMLElement).dataset.field;
    void onMove(t, e.key === 'ArrowUp' ? -1 : 1).then(() => requestAnimationFrame(() => {
      tableRef.current?.querySelector<HTMLElement>(`[data-task="${t.id}"] [data-field="${field}"]`)?.focus();
    }));
  };

  const submitNew = async () => {
    const name = draft.trim();
    if (!name) return;
    if (await onAdd(name)) setDraft('');
    requestAnimationFrame(() => addRef.current?.focus());
  };

  return (
    <div className="task-table-wrap">
      <table className="task-table" ref={tableRef}>
        <thead>
          <tr>
            <th scope="col" className="c-row"><span className="visually-hidden">Row</span></th>
            <th scope="col" className="c-name">Task</th>
            <th scope="col" className="c-env">Environment</th>
            <th scope="col" className="c-num">Days</th>
            <th scope="col" className="c-after" title="Rows this task waits for. 2+3 means three working days after row 2 ends.">After</th>
            <th scope="col" className="c-date">Start</th>
            <th scope="col" className="c-date">Finish</th>
            <th scope="col" className="c-num">Float</th>
            <th scope="col" className="c-status">Status</th>
          </tr>
        </thead>
        <tbody>
          {plan.tasks.map((t) => {
            const s = schedule.get(t.id);
            const env = environments.find((e) => e.id === t.environment_id);
            const overdue = t.status !== 'done' && t.status !== 'in_progress' && s && s.start < today;
            return (
              <tr
                key={t.id}
                data-task={t.id}
                className={`${s?.critical ? 'is-critical' : ''}${t.status === 'done' ? ' is-done' : ''}`}
                style={{ ['--env-color' as string]: env ? ENV_COLOR[env.kind] : 'transparent' } as CSSProperties}
                onKeyDown={(e) => rowKeys(e, t)}
              >
                <td className="c-row">
                  <button type="button" className="row-num" onClick={() => onOpen(t.id)} aria-label={`Open ${t.name}`} title="Open task">
                    {rowOf.get(t.id)}
                  </button>
                </td>
                <td className="c-name">
                  <div className="name-cell">
                  <CellInput
                    field="name"
                    label="Task name"
                    value={t.name}
                    onCommit={(v) => (v.trim() && v.trim() !== t.name ? onUpdate(t, { name: v.trim() }) : undefined)}
                    onEnter={() => {
                      if (rowOf.get(t.id) === plan.tasks.length) addRef.current?.focus();
                    }}
                  />
                  {t.assignee && <span className="task-assignee">{t.assignee}</span>}
                  </div>
                </td>
                <td className="c-env" data-label="Environment">
                  <select
                    data-field="env"
                    aria-label="Environment"
                    value={t.environment_id ?? ''}
                    onChange={(e) => void onUpdate(t, { environment_id: e.target.value ? Number(e.target.value) : null })}
                  >
                    <option value="">None</option>
                    {environments.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
                  </select>
                </td>
                <td className="c-num" data-label="Days">
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
                </td>
                <td className="c-after" data-label="After">
                  <CellInput
                    field="after"
                    label="After rows"
                    value={formatPredecessors(plan.dependencies, t.id, rowOf)}
                    placeholder="—"
                    onCommit={(v) => {
                      const parsed = parsePredecessors(v, plan.tasks.length, rowOf.get(t.id)!);
                      if (!parsed.ok) { onError(parsed.error); return false; }
                      if (v.trim() === formatPredecessors(plan.dependencies, t.id, rowOf)) return undefined;
                      return onUpdate(t, {
                        predecessors: parsed.rows.map((r) => ({ id: plan.tasks[r.row - 1].id, lag: r.lag })),
                      });
                    }}
                  />
                </td>
                <td className="c-date" data-label="Start">
                  {s ? <DateCell field="start" label={`Start of ${t.name}`} value={s.start} onCommit={(d) => onSetStart(t, d)} /> : '—'}
                </td>
                <td className="c-date" data-label="Finish">
                  {s ? <DateCell field="finish" label={`Finish of ${t.name}`} value={s.end} onCommit={(d) => onSetFinish(t, d)} /> : '—'}
                </td>
                <td className="c-num c-float" data-label="Float">
                  {s ? (s.critical ? <strong>critical</strong> : `${s.total_float}d`) : '—'}
                </td>
                <td className="c-status" data-label="Status">
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
                  {overdue && <span className="overdue" title={`Scheduled to start ${formatDate(s!.start)}`}>should have started</span>}
                </td>
              </tr>
            );
          })}
          <tr className="task-add">
            <td className="c-row"><span className="row-num is-new" aria-hidden="true">+</span></td>
            <td colSpan={8}>
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
      <p className="table-hint">
        Enter moves on, Alt+↑/↓ reorders. In After, write rows: <kbd>2</kbd>, or <kbd>2+3</kbd> to wait three working days.
        A typed finish sets Days, counting working days only; a typed start is the earliest the task may begin.
      </p>
    </div>
  );
}

/**
 * An input that commits on Enter or blur and reverts on Escape. `onCommit`
 * returning false keeps the typed value for fixing; undefined means nothing changed.
 */
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
  task, plan, rowOf, schedule, environments, envName, saving, onClose, onSave, onDelete,
}: {
  task: Task;
  plan: PlanData;
  rowOf: ReadonlyMap<number, number>;
  schedule?: TaskSchedule;
  environments: readonly Environment[];
  envName: (id: number | null) => string | undefined;
  saving: boolean;
  onClose: () => void;
  onSave: (fields: TaskInput) => void;
  onDelete: (bridge: boolean) => void;
}) {
  const [name, setName] = useState(task.name);
  const [envId, setEnvId] = useState<number | null>(task.environment_id);
  const [duration, setDuration] = useState(String(task.duration));
  const [after, setAfter] = useState(formatPredecessors(plan.dependencies, task.id, rowOf));
  const [notBefore, setNotBefore] = useState(task.not_before ?? '');
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [actualStart, setActualStart] = useState(task.actual_start ?? '');
  const [actualEnd, setActualEnd] = useState(task.actual_end ?? '');
  const [assignee, setAssignee] = useState(task.assignee ?? '');
  const [note, setNote] = useState(task.note ?? '');
  const [bridge, setBridge] = useState(true);
  const [deleteImpact, setDeleteImpact] = useState<PlanImpact | null>(null);
  const [editImpact, setEditImpact] = useState<PlanImpact | null>(null);

  const parsed = parsePredecessors(after, plan.tasks.length, rowOf.get(task.id)!);
  const days = Number(duration);
  const valid = name.trim() && Number.isInteger(days) && days >= 0 && parsed.ok;

  /** Only what changed goes to the server, so undo and the audit log stay precise. */
  const fields = useMemo<TaskInput>(() => {
    const f: TaskInput = {};
    if (name.trim() !== task.name) f.name = name.trim();
    if (envId !== task.environment_id) f.environment_id = envId;
    if (Number.isInteger(days) && days !== task.duration) f.duration = days;
    if (parsed.ok && after.trim() !== formatPredecessors(plan.dependencies, task.id, rowOf)) {
      f.predecessors = parsed.rows.map((r) => ({ id: plan.tasks[r.row - 1].id, lag: r.lag }));
    }
    if ((notBefore || null) !== task.not_before) f.not_before = notBefore || null;
    if (status !== task.status) f.status = status;
    if ((actualStart || null) !== task.actual_start && status !== 'todo') f.actual_start = actualStart || null;
    if ((actualEnd || null) !== task.actual_end && status === 'done') f.actual_end = actualEnd || null;
    if ((assignee.trim() || null) !== task.assignee) f.assignee = assignee.trim() || null;
    if ((note.trim() || null) !== task.note) f.note = note.trim() || null;
    return f;
  }, [name, envId, days, after, notBefore, status, actualStart, actualEnd, assignee, note, task, plan, rowOf]);

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
    api.previewTask(plan.project.id, { op: 'delete', id: task.id, bridge })
      .then(setDeleteImpact).catch(() => setDeleteImpact(null));
  }, [task.id, bridge, plan.project.id]);

  const successors = plan.dependencies.filter((d) => d.predecessor_id === task.id).length;
  const predecessors = plan.dependencies.filter((d) => d.successor_id === task.id).length;

  return (
    <Modal
      title={task.name}
      subtitle={[
        `Row ${rowOf.get(task.id)}`,
        envName(task.environment_id) ? `on ${envName(task.environment_id)}` : 'no environment',
        schedule ? formatRange(schedule.start, schedule.end) : null,
        schedule ? (schedule.critical ? 'critical' : `${schedule.total_float} days float`) : null,
      ].filter(Boolean).join(', ')}
      busy={saving}
      onClose={onClose}
      footer={
        <>
          <DangerButton
            label="Delete task"
            confirmLabel={deleteImpact && deleteImpact.risk === 'high' ? 'Delete anyway?' : 'Delete it?'}
            onConfirm={() => onDelete(bridge)}
            disabled={saving}
          />
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" disabled={!dirty || !valid || saving || !!editImpact?.cycle} onClick={() => onSave(fields)}>
            Save changes
          </button>
        </>
      }
    >
      <div className="dialog-body task-editor">
        <label className="stack">
          Task
          <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
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
        <div className="pair">
          <label className="stack">
            After rows
            <input value={after} onChange={(e) => setAfter(e.target.value)} placeholder="e.g. 2, 3+1" aria-invalid={!parsed.ok || undefined} />
            <span className="field-hint">{parsed.ok ? 'Starts when these rows finish, plus any lag.' : parsed.error}</span>
          </label>
          <label className="stack">
            Start no earlier than
            <input type="date" value={notBefore} onChange={(e) => setNotBefore(e.target.value)} />
          </label>
        </div>
        <div className="pair">
          <label className="stack">
            Status
            <select value={status} onChange={(e) => setStatus(e.target.value as TaskStatus)}>
              {STATUSES.map((x) => <option key={x} value={x}>{STATUS_LABEL[x]}</option>)}
            </select>
          </label>
          <label className="stack">
            Assignee
            <input value={assignee} onChange={(e) => setAssignee(e.target.value)} placeholder="Who does it" />
          </label>
        </div>
        {status !== 'todo' && status !== 'blocked' && (
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
