import { useEffect, useMemo, useRef, useState } from 'react';
import { BASELINE_NAME_MAX, BASELINES_MAX, type Baseline, type ISODate } from '../../shared/types.ts';
import { formatShift, workingShift } from '../../shared/variance.ts';
import { formatDate } from '../layout.ts';
import { DangerButton } from './Dialogs.tsx';

/**
 * The plan's saved baselines (reqs/pm_features.md §4.5), from the facts row:
 * "Compare with [name]" and how far the finish has moved from it, opening a
 * popover with the slip chart, the list to pick from, and Save current plan as.
 *
 * Only the one compared with is read by anything else (ghost bars, variance,
 * the assistant); the others are history. No colour: dots and a line in ink.
 */

export type BaselineActions = {
  onSave: (name: string) => Promise<boolean>;
  onCompare: (id: number) => Promise<boolean>;
  onRename: (id: number, name: string) => Promise<boolean>;
  onDelete: (id: number) => Promise<boolean>;
};

/** "Baseline 2026-10-04", or with (2), (3)… when that name is taken. */
export function defaultBaselineName(today: ISODate, taken: readonly string[]): string {
  const lower = new Set(taken.map((n) => n.toLowerCase()));
  const base = `Baseline ${today}`;
  if (!lower.has(base.toLowerCase())) return base;
  for (let i = 2; i <= BASELINES_MAX + 1; i++) if (!lower.has(`${base} (${i})`.toLowerCase())) return `${base} (${i})`;
  return base;
}

export function BaselinePicker({
  baselines, compareId, finish, today, holidays, busy, open, focusSave, onOpenChange, actions,
}: {
  baselines: readonly Baseline[];
  compareId: number | null;
  /** The plan's finish now, for the variance and the slip chart's last point. */
  finish: ISODate | null;
  today: ISODate;
  holidays: ReadonlySet<ISODate>;
  busy: boolean;
  open: boolean;
  /** Opened from "Save baseline…": the name field takes the caret. */
  focusSave: boolean;
  onOpenChange: (open: boolean, focusSave?: boolean) => void;
  actions: BaselineActions;
}) {
  const compared = baselines.find((b) => b.id === compareId) ?? null;
  const shift = compared?.finish && finish ? workingShift(compared.finish, finish, holidays) : null;
  const wrap = useRef<HTMLDivElement>(null);

  // A click outside or Escape closes it, as a menu does.
  useEffect(() => {
    if (!open) return;
    const down = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) onOpenChange(false); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onOpenChange(false); };
    document.addEventListener('mousedown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key); };
  }, [open, onOpenChange]);

  return (
    <div className="baseline-picker" ref={wrap}>
      <button
        type="button"
        className="baseline-button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => onOpenChange(!open)}
        title={compared ? `Saved ${savedOn(compared)}. Ghost bars, variance and the assistant compare with it.` : 'Save the plan as it stands to compare against later'}
      >
        {compared ? compared.name : baselines.length ? 'None' : 'No baseline'}
        <svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 3.5 5 6.5 8 3.5" /></svg>
      </button>
      {shift != null && (
        <span className={`baseline-shift${shift > 0 ? ' is-later' : ''}`}
          title={`The plan finishes ${Math.abs(shift)} working day${Math.abs(shift) === 1 ? '' : 's'} ${shift > 0 ? 'later' : shift < 0 ? 'sooner' : ''} than ${compared!.name}${shift === 0 ? ' said, on the same day' : ''}`}>
          {formatShift(shift)}
        </span>
      )}
      {open && (
        <BaselinePopover
          baselines={baselines}
          compareId={compareId}
          finish={finish}
          today={today}
          busy={busy}
          focusSave={focusSave}
          actions={actions}
        />
      )}
    </div>
  );
}

function savedOn(b: Baseline): string {
  return formatDate(b.saved_at.slice(0, 10));
}

function BaselinePopover({ baselines, compareId, finish, today, busy, focusSave, actions }: {
  baselines: readonly Baseline[];
  compareId: number | null;
  finish: ISODate | null;
  today: ISODate;
  busy: boolean;
  focusSave: boolean;
  actions: BaselineActions;
}) {
  const [name, setName] = useState(() => defaultBaselineName(today, baselines.map((b) => b.name)));
  const [renaming, setRenaming] = useState<{ id: number; text: string } | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (focusSave) { nameRef.current?.focus(); nameRef.current?.select(); } }, [focusSave]);
  // A new default once the last one was used.
  useEffect(() => { setName(defaultBaselineName(today, baselines.map((b) => b.name))); }, [baselines.length]);

  const full = baselines.length >= BASELINES_MAX;
  const trimmed = name.trim();
  const taken = baselines.some((b) => b.name.toLowerCase() === trimmed.toLowerCase());
  const save = async () => {
    if (!trimmed || taken || full) return;
    await actions.onSave(trimmed);
  };
  const rename = async () => {
    if (!renaming) return;
    const text = renaming.text.trim();
    const was = baselines.find((b) => b.id === renaming.id);
    if (!text || text === was?.name) { setRenaming(null); return; }
    if (await actions.onRename(renaming.id, text)) setRenaming(null);
  };

  return (
    <div className="baseline-popover" role="dialog" aria-label="Baselines">
      <section>
        <h3>How the finish has moved</h3>
        {baselines.some((b) => b.finish) && finish
          ? <SlipChart baselines={baselines} finish={finish} compareId={compareId} />
          : <p className="baseline-empty">Save a baseline, and each one you save adds a point here: the finish it promised. A line that keeps climbing is a plan that keeps slipping.</p>}
      </section>

      {baselines.length > 0 && (
        <section>
          <h3>Compare with</h3>
          <ul className="baseline-list">
            {[...baselines].reverse().map((b) => (
              <li key={b.id} className={b.id === compareId ? 'is-compared' : undefined}>
                {renaming?.id === b.id ? (
                  <input
                    className="baseline-rename"
                    autoFocus
                    aria-label={`New name for ${b.name}`}
                    maxLength={BASELINE_NAME_MAX}
                    value={renaming.text}
                    onChange={(e) => setRenaming({ id: b.id, text: e.target.value })}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') { e.preventDefault(); void rename(); }
                      if (e.key === 'Escape') { e.stopPropagation(); setRenaming(null); }
                    }}
                    onBlur={() => void rename()}
                  />
                ) : (
                  <label className="baseline-choice" onDoubleClick={() => setRenaming({ id: b.id, text: b.name })}>
                    <input type="radio" name="compare-baseline" checked={b.id === compareId} disabled={busy}
                      onChange={() => void actions.onCompare(b.id)} />
                    <span className="baseline-name">{b.name}</span>
                  </label>
                )}
                <span className="baseline-meta">saved {savedOn(b)}</span>
                <span className="baseline-finish">{b.finish ? formatDate(b.finish) : '—'}</span>
                <span className="baseline-row-actions">
                  <button type="button" className="link-button" disabled={busy} onClick={() => setRenaming({ id: b.id, text: b.name })}
                    aria-label={`Rename ${b.name}`}>Rename</button>
                  <DangerButton label="Delete" confirmLabel="Delete it?" disabled={busy} onConfirm={() => void actions.onDelete(b.id)} />
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h3><label htmlFor="baseline-name">Save current plan as</label></h3>
        <form className="baseline-save" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          <input id="baseline-name" ref={nameRef} value={name} maxLength={BASELINE_NAME_MAX} disabled={full}
            onChange={(e) => setName(e.target.value)} />
          <button type="submit" className="btn" disabled={busy || !trimmed || taken || full}>Save</button>
        </form>
        <p className="baseline-note">
          {full ? `A plan keeps ${BASELINES_MAX} baselines. Delete one to save another.`
            : taken ? `There is already a baseline called “${trimmed}”.`
              : `${baselines.length} of ${BASELINES_MAX} kept. ${baselines.length ? 'Saving keeps the one you compare with.' : 'The first one becomes the one you compare with.'}`}
        </p>
      </section>
    </div>
  );
}

/**
 * The milestone trend: each baseline's promised finish, oldest on the left, and
 * the plan's finish now as an open dot. Ink only; the compared one is larger.
 */
function SlipChart({ baselines, finish, compareId }: { baselines: readonly Baseline[]; finish: ISODate; compareId: number | null }) {
  const points = useMemo(() => [
    ...baselines.filter((b) => b.finish).map((b) => ({ key: String(b.id), label: savedOnShort(b), date: b.finish!, now: false, compared: b.id === compareId, name: b.name })),
    { key: 'now', label: 'Now', date: finish, now: true, compared: false, name: 'The plan now' },
  ], [baselines, finish, compareId]);
  const W = 400;
  const H = 150;
  const left = 36;
  const right = 24;
  const top = 26;
  const bottom = 30;
  const days = points.map((p) => Date.parse(p.date));
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  const span = hi - lo || 1;
  const y = (d: number) => (hi === lo ? (top + H - bottom) / 2 : H - bottom - ((d - lo) / span) * (H - bottom - top));
  const x = (i: number) => (points.length === 1 ? (left + W - right) / 2 : left + (i * (W - left - right)) / (points.length - 1));
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(days[i]).toFixed(1)}`).join(' ');
  const solid = line.split(' L').slice(0, Math.max(1, points.length - 1)).join(' L');
  const last = points.length - 1;

  return (
    <svg className="slip-chart" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Finish by baseline: ${points.map((p) => `${p.name}, ${formatDate(p.date)}`).join('; ')}`}>
      <line className="slip-axis" x1={left} x2={W - right} y1={H - bottom + 6} y2={H - bottom + 6} />
      {points.length > 2 && <path className="slip-line" d={solid} />}
      {points.length > 1 && (
        <path className="slip-line is-now" d={`M${x(last - 1).toFixed(1)} ${y(days[last - 1]).toFixed(1)} L${x(last).toFixed(1)} ${y(days[last]).toFixed(1)}`} />
      )}
      {points.map((p, i) => (
        <g key={p.key} className={`slip-point${p.now ? ' is-now' : ''}${p.compared ? ' is-compared' : ''}`}>
          <title>{`${p.name}: finish ${formatDate(p.date)}`}</title>
          <circle cx={x(i)} cy={y(days[i])} r={p.compared ? 5.5 : 4.5} />
          <text className="slip-value" x={x(i)} y={y(days[i]) - 10} textAnchor="middle">{formatDate(p.date)}</text>
          <text className="slip-tick" x={x(i)} y={H - 8} textAnchor="middle">{p.label}</text>
        </g>
      ))}
    </svg>
  );
}

function savedOnShort(b: Baseline): string {
  return formatDate(b.saved_at.slice(0, 10));
}
