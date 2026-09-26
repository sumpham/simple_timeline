import { useEffect, useRef, useState, type ReactNode } from 'react';
import { calendarDays, isWeekend, workingDays } from '../../shared/dates.ts';
import { MARKERS, type BookingView, type Environment, type ISODate, type Marker, type Project, type Team } from '../../shared/types.ts';
import { MarkerIcon } from './Board.tsx';

/** A dialog that traps focus and closes on Escape, via the native element. */
export function Modal({
  title, subtitle, children, footer, onClose, busy = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
  /** A save is in flight: a bar runs along the top so the wait never looks like nothing. */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog
      ref={ref}
      aria-busy={busy || undefined}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      onClose={onClose}
    >
      {busy && <div className="dialog-progress" role="progressbar" aria-label="Saving" />}
      <div className="dialog-head">
        <h2>{title}</h2>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {children}
      <div className="dialog-foot">{footer}</div>
    </dialog>
  );
}


/**
 * Destructive actions arm before they fire, and say what they take with them.
 * Two taps in place, rather than a blocking confirm() or a second stacked dialog.
 */
export function DangerButton({
  label, confirmLabel, onConfirm, disabled = false,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return;
    // Disarm on its own so a half-pressed delete never sits waiting.
    const t = setTimeout(() => setArmed(false), 4000);
    return () => clearTimeout(t);
  }, [armed]);

  return (
    <button
      type="button"
      className={`btn danger${armed ? ' armed' : ''}`}
      disabled={disabled}
      onClick={() => { if (armed) { onConfirm(); setArmed(false); } else setArmed(true); }}
    >
      {armed ? confirmLabel : label}
    </button>
  );
}

/** The label a button shows while its own action is in flight, with a spinner. */
function Working({ label }: { label: string }) {
  return (
    <>
      <span className="btn-spinner" aria-hidden="true" />
      {label}
    </>
  );
}

export type BookingDraft = {
  id?: number;
  project_id: number;
  environment_id: number;
  kind: string;
  start_date: ISODate;
  end_date: ISODate;
  confidence: string;
  optional: boolean;
  note: string;
  /** Only meaningful when kind is CUSTOM. */
  marker: Marker | null;
};

const MARKER_LABEL: Record<Marker, string> = { star: 'Star', flag: 'Flag', pin: 'Pin' };

export function BookingDialog({
  draft, projects, environments, holidays, onSave, onDelete, onClose, error,
}: {
  draft: BookingDraft;
  projects: Project[];
  environments: Environment[];
  holidays: ISODate[];
  /** Resolves once the save, and the board refresh after it, are done. */
  onSave: (d: BookingDraft) => Promise<unknown> | void;
  onDelete?: () => Promise<unknown> | void;
  onClose: () => void;
  error?: string;
}) {
  const [form, setForm] = useState(draft);
  /**
   * Which action is in flight. A save waits on the server and then on the board
   * refresh, which together can take seconds; without this the dialog just sat
   * there and a save looked like it had not happened.
   */
  const [pending, setPending] = useState<'save' | 'delete' | null>(null);
  const perform = async (which: 'save' | 'delete', action: () => Promise<unknown> | void) => {
    if (pending) return;
    setPending(which);
    try {
      await action();
    } finally {
      // On success the dialog has usually closed by now; on failure it stays, with the error.
      setPending(null);
    }
  };
  const holidaySet = new Set(holidays);
  const isMilestone = form.kind === 'RELEASE';
  const isCustom = form.kind === 'CUSTOM';
  const end = isMilestone ? form.start_date : form.end_date;

  const valid = form.start_date && end && end >= form.start_date;
  const effort = valid ? workingDays(form.start_date, end, holidaySet) : 0;
  const occupied = valid ? calendarDays(form.start_date, end) : 0;

  // Surfacing the snap before saving beats surprising the user afterwards.
  const startOffDay = form.start_date && (isWeekend(form.start_date) || holidaySet.has(form.start_date));
  const endOffDay = !isMilestone && end && (isWeekend(end) || holidaySet.has(end));

  return (
    <Modal
      title={draft.id ? 'Edit booking' : 'Book an environment'}
      subtitle={draft.id ? undefined : 'Pick the project, the environment, and the dates it is held.'}
      busy={pending != null}
      // Closing mid-save would hide the outcome; the save closes the dialog itself.
      onClose={() => { if (!pending) onClose(); }}
      footer={
        <>
          {onDelete && (pending === 'delete' ? (
            <button type="button" className="btn danger" disabled><Working label="Removing…" /></button>
          ) : (
            <DangerButton
              label="Remove booking"
              confirmLabel="Remove it?"
              disabled={pending != null}
              onConfirm={() => void perform('delete', onDelete)}
            />
          ))}
          <span className="spacer" />
          <button type="button" className="btn quiet" disabled={pending != null} onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn"
            disabled={!valid || pending != null}
            onClick={() => void perform('save', () => onSave({ ...form, end_date: end, marker: isCustom ? form.marker : null }))}
          >
            {pending === 'save'
              ? <Working label={draft.id ? 'Saving…' : 'Booking…'} />
              : (draft.id ? 'Save changes' : 'Book environment')}
          </button>
        </>
      }
    >
      <fieldset className="dialog-body" disabled={pending != null}>
        {error && <p className="note warn">{error}</p>}

        <label className="stack">
          Project
          <select
            value={form.project_id}
            onChange={(e) => setForm({ ...form, project_id: Number(e.target.value) })}
          >
            {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>

        <div className="pair">
          <label className="stack">
            Environment
            <select
              value={form.environment_id}
              onChange={(e) => setForm({ ...form, environment_id: Number(e.target.value) })}
            >
              {environments.map((env) => <option key={env.id} value={env.id}>{env.name}</option>)}
            </select>
          </label>

          <label className="stack">
            Kind
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              {['SIT', 'UAT', 'NFT', 'PENTEST', 'RELEASE', 'CUSTOM'].map((k) => (
                <option key={k} value={k}>{k === 'RELEASE' ? 'Release (one day)' : k}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="pair">
          <label className="stack">
            {isMilestone ? 'Release date' : 'Starts'}
            <input
              type="date"
              value={form.start_date}
              onChange={(e) => setForm({ ...form, start_date: e.target.value })}
            />
          </label>
          {!isMilestone && (
            <label className="stack">
              Ends
              <input
                type="date"
                value={form.end_date}
                min={form.start_date}
                onChange={(e) => setForm({ ...form, end_date: e.target.value })}
              />
            </label>
          )}
        </div>

        <label className="stack">
          Confidence
          <select
            value={form.confidence}
            onChange={(e) => setForm({ ...form, confidence: e.target.value })}
          >
            <option value="committed">Committed — counts towards double-bookings</option>
            <option value="tentative">Tentative — shown hatched, not counted</option>
          </select>
        </label>

        {isCustom && (
          <div className="stack">
            <span id="marker-label">Marker on the timeline</span>
            <div className="segmented marker-picker" role="group" aria-labelledby="marker-label">
              <button
                type="button"
                aria-pressed={form.marker == null}
                onClick={() => setForm({ ...form, marker: null })}
              >
                None
              </button>
              {MARKERS.map((m) => (
                <button
                  key={m}
                  type="button"
                  aria-pressed={form.marker === m}
                  onClick={() => setForm({ ...form, marker: m })}
                >
                  <MarkerIcon marker={m} className="marker-picker-icon" />
                  {MARKER_LABEL[m]}
                </button>
              ))}
            </div>
          </div>
        )}

        <label className="stack">
          Note
          <textarea
            rows={3}
            maxLength={2000}
            value={form.note}
            placeholder="Anything the next person looking at this booking should know"
            onChange={(e) => setForm({ ...form, note: e.target.value })}
          />
        </label>

        {valid && !isMilestone && (
          <p className="note">
            {effort} working day{effort === 1 ? '' : 's'} of work.
            {occupied !== effort && ` The environment is held for ${occupied} calendar days, weekends included.`}
          </p>
        )}

        {(startOffDay || endOffDay) && (
          <p className="note warn">
            Bookings start and end on working days. These dates will move to the nearest one.
          </p>
        )}
      </fieldset>
    </Modal>
  );
}

/** One project's fields, used inside the projects manager. */
function ProjectForm({
  initial, onSave, onCancel,
}: {
  initial?: Project;
  onSave: (p: { name: string; owner: string | null; priority: Project['priority']; status: Project['status'] }) => void;
  onCancel?: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? '');
  const [owner, setOwner] = useState(initial?.owner ?? '');
  const [priority, setPriority] = useState<Project['priority']>(initial?.priority ?? 'normal');
  const [status, setStatus] = useState<Project['status']>(initial?.status ?? 'planned');

  const submit = () => onSave({ name: name.trim(), owner: owner.trim() || null, priority, status });

  return (
    <div className="inline-form">
      <label className="stack">
        Name
        <input
          value={name}
          autoFocus
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && name.trim()) submit(); }}
          placeholder="Card tokenisation R2"
        />
      </label>
      <label className="stack">
        Owner
        <input value={owner ?? ''} onChange={(e) => setOwner(e.target.value)} placeholder="Who runs it" />
      </label>
      <div className="pair">
        <label className="stack">
          Priority
          <select value={priority} onChange={(e) => setPriority(e.target.value as Project['priority'])}>
            {['low', 'normal', 'high', 'critical'].map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
        <label className="stack">
          Status
          <select value={status} onChange={(e) => setStatus(e.target.value as Project['status'])}>
            {['planned', 'in_progress', 'on_hold', 'done', 'cancelled'].map((x) => (
              <option key={x} value={x}>{x.replace('_', ' ')}</option>
            ))}
          </select>
        </label>
      </div>
      <div className="inline-actions">
        {onCancel && <button type="button" className="btn quiet" onClick={onCancel}>Cancel</button>}
        <button type="button" className="btn" disabled={!name.trim()} onClick={submit}>
          {initial ? 'Save changes' : 'Add project'}
        </button>
      </div>
    </div>
  );
}

export function ProjectsDialog({
  projects, teamName, initialEditingId, onCreate, onUpdate, onDelete, onBook, onClose, error, busy,
}: {
  projects: Project[];
  teamName: string;
  initialEditingId?: number | null;
  onCreate: (p: { name: string; owner: string | null; priority: Project['priority']; status: Project['status'] }) => void;
  onUpdate: (id: number, p: Partial<Project>) => void;
  onDelete: (id: number) => void;
  onBook: (projectId: number) => void;
  onClose: () => void;
  error?: string;
  busy?: boolean;
}) {
  const [editing, setEditing] = useState<number | null>(initialEditingId ?? null);
  const [adding, setAdding] = useState(false);

  return (
    <Modal
      title="Projects"
      busy={busy}
      subtitle={`${projects.length || 'No'} project${projects.length === 1 ? '' : 's'} in ${teamName}. Projects book environments.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={() => { setAdding(true); setEditing(null); }}>
            Add project
          </button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="dialog-body">
        {error && <p className="note warn">{error}</p>}

        {projects.length === 0 && !adding && (
          <p className="note">No projects yet. Add one, then book an environment for it.</p>
        )}

        {projects.map((project) => (
          <div key={project.id} className="manager-item">
            {editing === project.id ? (
              <ProjectForm
                initial={project}
                onCancel={() => setEditing(null)}
                onSave={(p) => { onUpdate(project.id, p); setEditing(null); }}
              />
            ) : (
              <div className="manager-row">
                <div className="manager-main">
                  <div className="manager-name">{project.name}</div>
                  <div className="manager-meta">
                    {[project.owner, project.priority, project.status.replace('_', ' ')]
                      .filter(Boolean).join(' · ')}
                    {` · ${project.booking_count ?? 0} booking${project.booking_count === 1 ? '' : 's'}`}
                  </div>
                </div>
                <button type="button" className="btn quiet" onClick={() => onBook(project.id)}>Book</button>
                <button type="button" className="btn quiet" onClick={() => { setEditing(project.id); setAdding(false); }}>
                  Edit
                </button>
                <DangerButton
                  label="Remove"
                  confirmLabel={project.booking_count
                    ? `Remove with ${project.booking_count} booking${project.booking_count === 1 ? '' : 's'}?`
                    : 'Remove it?'}
                  onConfirm={() => onDelete(project.id)}
                />
              </div>
            )}
          </div>
        ))}

        {adding && (
          <div className="manager-item is-new">
            <ProjectForm onCancel={() => setAdding(false)} onSave={(p) => { onCreate(p); setAdding(false); }} />
          </div>
        )}
      </div>
    </Modal>
  );
}

export function EnvironmentDialog({
  environments, teamName, onCreate, onUpdate, onDelete, onClose, error, busy,
}: {
  environments: Environment[];
  teamName: string;
  onCreate: (e: { name: string; kind: string; capacity: number }) => void;
  onUpdate: (id: number, e: Partial<Environment>) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  error?: string;
  busy?: boolean;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('SIT');
  const [adding, setAdding] = useState(false);

  return (
    <Modal
      title="Environments"
      busy={busy}
      subtitle={`${teamName} owns these. Capacity is how many projects may hold one at once — anything above it is a double-booking.`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={() => setAdding(true)}>Add environment</button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="dialog-body">
        {error && <p className="note warn">{error}</p>}

        {environments.map((env) => (
          <div key={env.id} className="manager-item">
            <div className="manager-row">
              <label className="stack grow">
                Name
                <input
                  defaultValue={env.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== env.name) onUpdate(env.id, { name: v });
                  }}
                />
              </label>
              <label className="stack">
                Kind
                <select value={env.kind} onChange={(e) => onUpdate(env.id, { kind: e.target.value as Environment['kind'] })}>
                  {['SIT', 'UAT', 'NFT', 'PENTEST', 'PROD', 'OTHER'].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <label className="stack narrow">
                Capacity
                <input
                  type="number"
                  min={1}
                  defaultValue={env.capacity}
                  onBlur={(e) => {
                    const v = Math.max(1, Number(e.target.value) || 1);
                    if (v !== env.capacity) onUpdate(env.id, { capacity: v });
                  }}
                />
              </label>
              <DangerButton
                label="Remove"
                confirmLabel={env.booking_count ? `${env.booking_count} booked — remove?` : 'Remove it?'}
                onConfirm={() => onDelete(env.id)}
              />
            </div>
          </div>
        ))}

        {adding && (
          <div className="manager-item is-new">
            <div className="manager-row">
              <label className="stack grow">
                New environment
                <input
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && name.trim()) {
                      onCreate({ name: name.trim(), kind, capacity: 1 });
                      setName(''); setAdding(false);
                    }
                  }}
                  placeholder="PENTEST"
                />
              </label>
              <label className="stack">
                Kind
                <select value={kind} onChange={(e) => setKind(e.target.value)}>
                  {['SIT', 'UAT', 'NFT', 'PENTEST', 'PROD', 'OTHER'].map((k) => <option key={k} value={k}>{k}</option>)}
                </select>
              </label>
              <div className="inline-actions">
                <button type="button" className="btn quiet" onClick={() => { setAdding(false); setName(''); }}>Cancel</button>
                <button
                  type="button"
                  className="btn"
                  disabled={!name.trim()}
                  onClick={() => { onCreate({ name: name.trim(), kind, capacity: 1 }); setName(''); setAdding(false); }}
                >
                  Add
                </button>
              </div>
            </div>
          </div>
        )}

        <p className="note">
          An environment holding bookings cannot be removed until those bookings go.
        </p>
      </div>
    </Modal>
  );
}

export function TeamsDialog({
  teams, currentId, onCreate, onUpdate, onDelete, onSelect, onClose, error, busy,
}: {
  teams: Team[];
  currentId: number | null;
  onCreate: (t: { name: string; code: string }) => void;
  onUpdate: (id: number, t: Partial<Team>) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
  onClose: () => void;
  error?: string;
  busy?: boolean;
}) {
  const [adding, setAdding] = useState(teams.length === 0);
  const [name, setName] = useState('');
  const [code, setCode] = useState('');

  const create = () => {
    if (!name.trim()) return;
    onCreate({ name: name.trim(), code: (code.trim() || name.trim().slice(0, 3)).toUpperCase() });
    setName(''); setCode(''); setAdding(false);
  };

  return (
    <Modal
      title="Teams"
      busy={busy}
      subtitle="A team owns its environments and the projects that book them. New teams start with SIT, UAT and PROD."
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn quiet" onClick={() => setAdding(true)}>Add team</button>
          <span className="spacer" />
          <button type="button" className="btn" onClick={onClose}>Done</button>
        </>
      }
    >
      <div className="dialog-body">
        {error && <p className="note warn">{error}</p>}

        {teams.map((team) => (
          <div key={team.id} className={`manager-item${team.id === currentId ? ' is-current' : ''}`}>
            <div className="manager-row">
              <label className="stack grow">
                Name
                <input
                  defaultValue={team.name}
                  onBlur={(e) => {
                    const v = e.target.value.trim();
                    if (v && v !== team.name) onUpdate(team.id, { name: v });
                  }}
                />
              </label>
              <label className="stack narrow">
                Code
                <input
                  defaultValue={team.code}
                  maxLength={6}
                  onBlur={(e) => {
                    const v = e.target.value.trim().toUpperCase();
                    if (v && v !== team.code) onUpdate(team.id, { code: v });
                  }}
                />
              </label>
              {team.id !== currentId && (
                <button type="button" className="btn quiet" onClick={() => onSelect(team.id)}>Open</button>
              )}
              <DangerButton
                label="Remove"
                confirmLabel={team.project_count
                  ? `Removes ${team.project_count} project${team.project_count === 1 ? '' : 's'} and ${team.booking_count ?? 0} booking${team.booking_count === 1 ? '' : 's'} — go ahead?`
                  : 'Remove it?'}
                onConfirm={() => onDelete(team.id)}
              />
            </div>
            <div className="manager-meta indent">
              {team.project_count ?? 0} project{team.project_count === 1 ? '' : 's'} ·{' '}
              {team.booking_count ?? 0} booking{team.booking_count === 1 ? '' : 's'}
              {team.id === currentId ? ' · showing on the board' : ''}
            </div>
          </div>
        ))}

        {adding && (
          <div className="manager-item is-new">
            <div className="manager-row">
              <label className="stack grow">
                New team
                <input
                  value={name}
                  autoFocus
                  onChange={(e) => setName(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') create(); }}
                  placeholder="Payments Platform"
                />
              </label>
              <label className="stack narrow">
                Code
                <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="PAY" maxLength={6} />
              </label>
              <div className="inline-actions">
                {teams.length > 0 && (
                  <button type="button" className="btn quiet" onClick={() => setAdding(false)}>Cancel</button>
                )}
                <button type="button" className="btn" disabled={!name.trim()} onClick={create}>Add</button>
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

export type { BookingView };
