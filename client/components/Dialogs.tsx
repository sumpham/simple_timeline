import { useEffect, useRef, useState, type ReactNode } from 'react';
import { calendarDays, isWeekend, workingDays } from '../../shared/dates.ts';
import type { BookingView, Environment, ISODate, Project, Team } from '../../shared/types.ts';

/** A dialog that traps focus and closes on Escape, via the native element. */
export function Modal({
  title, subtitle, children, footer, onClose,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer: ReactNode;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); onClose(); }} onClose={onClose}>
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
  label, confirmLabel, onConfirm,
}: {
  label: string;
  confirmLabel: string;
  onConfirm: () => void;
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
      onClick={() => { if (armed) { onConfirm(); setArmed(false); } else setArmed(true); }}
    >
      {armed ? confirmLabel : label}
    </button>
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
};

export function BookingDialog({
  draft, projects, environments, holidays, onSave, onDelete, onClose, error,
}: {
  draft: BookingDraft;
  projects: Project[];
  environments: Environment[];
  holidays: ISODate[];
  onSave: (d: BookingDraft) => void;
  onDelete?: () => void;
  onClose: () => void;
  error?: string;
}) {
  const [form, setForm] = useState(draft);
  const holidaySet = new Set(holidays);
  const isMilestone = form.kind === 'RELEASE';
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
      onClose={onClose}
      footer={
        <>
          {onDelete && (
            <DangerButton label="Remove booking" confirmLabel="Remove it?" onConfirm={onDelete} />
          )}
          <span className="spacer" />
          <button type="button" className="btn quiet" onClick={onClose}>Cancel</button>
          <button
            type="button"
            className="btn"
            disabled={!valid}
            onClick={() => onSave({ ...form, end_date: end })}
          >
            {draft.id ? 'Save changes' : 'Book environment'}
          </button>
        </>
      }
    >
      <div className="dialog-body">
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
      </div>
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
  projects, teamName, initialEditingId, onCreate, onUpdate, onDelete, onBook, onClose, error,
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
}) {
  const [editing, setEditing] = useState<number | null>(initialEditingId ?? null);
  const [adding, setAdding] = useState(false);

  return (
    <Modal
      title="Projects"
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
  environments, teamName, onCreate, onUpdate, onDelete, onClose, error,
}: {
  environments: Environment[];
  teamName: string;
  onCreate: (e: { name: string; kind: string; capacity: number }) => void;
  onUpdate: (id: number, e: Partial<Environment>) => void;
  onDelete: (id: number) => void;
  onClose: () => void;
  error?: string;
}) {
  const [name, setName] = useState('');
  const [kind, setKind] = useState('SIT');
  const [adding, setAdding] = useState(false);

  return (
    <Modal
      title="Environments"
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
  teams, currentId, onCreate, onUpdate, onDelete, onSelect, onClose, error,
}: {
  teams: Team[];
  currentId: number | null;
  onCreate: (t: { name: string; code: string }) => void;
  onUpdate: (id: number, t: Partial<Team>) => void;
  onDelete: (id: number) => void;
  onSelect: (id: number) => void;
  onClose: () => void;
  error?: string;
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
