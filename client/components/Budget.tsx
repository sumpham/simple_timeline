import { useEffect, useState, type CSSProperties } from 'react';
import { api } from '../api.ts';
import type { ISODate } from '../../shared/types.ts';
import { diffDays, isValidISODate } from '../../shared/dates.ts';
import { formatMoney, type EarnedValue, type Figures, type Missing } from '../../shared/earnedValue.ts';
import { formatDate } from '../layout.ts';

/**
 * The Budget tab (reqs/pm_features.md §6.4): are we behind, are we over, and
 * where is the money heading, at a status date. Every number is
 * shared/earnedValue.ts's, fetched from the server; this only lays them out.
 *
 * Words first, indices second. No colour is spent: lines differ by stroke and
 * are named at their ends, and an index well under plan is bold, never red.
 */

export const CURRENCIES = ['EUR', 'USD', 'GBP', 'VND', 'JPY', 'AUD', 'SGD', 'CHF', 'CAD', 'INR'] as const;

/** Below this an index reads in bold: well off plan, worth a look. */
const LOW_INDEX = 0.9;

export function BudgetView({ projectId, version, today, currency, compareName, onSaveBaseline, onShowCosts, onCurrency }: {
  projectId: number;
  /** Changes whenever the plan does, so the figures follow it. */
  version: unknown;
  today: ISODate;
  currency: string;
  compareName: string | null;
  onSaveBaseline: () => void;
  onShowCosts: () => void;
  onCurrency: (code: string) => void;
}) {
  const [statusDate, setStatusDate] = useState<ISODate>(today);
  const [data, setData] = useState<EarnedValue | Missing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api.earnedValue(projectId, statusDate)
      .then((d) => { if (live) { setData(d); setError(null); } })
      .catch((err) => { if (live) setError(err instanceof Error ? err.message : 'Could not work out earned value'); });
    return () => { live = false; };
  }, [projectId, statusDate, version]);

  return (
    <div className="budget">
      <div className="budget-tools" role="toolbar" aria-label="Budget">
        <label className="budget-field">
          Status date
          <input type="date" value={statusDate} onChange={(e) => { if (isValidISODate(e.target.value)) setStatusDate(e.target.value); }} />
        </label>
        {statusDate !== today && <button type="button" className="btn quiet" onClick={() => setStatusDate(today)}>Today</button>}
        <span className="budget-compare">
          Compare with <strong>{compareName ?? 'no baseline'}</strong>
          <span className="toolbar-note"> (change it above, in the plan’s facts)</span>
        </span>
        <span className="spacer" />
        <label className="budget-field">
          Currency
          <select value={currency} onChange={(e) => onCurrency(e.target.value)}>
            {[...new Set([currency, ...CURRENCIES])].map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
      </div>

      {error && <div className="error-bar" role="alert">{error}</div>}
      {!data && !error && <div className="empty"><p>Working out earned value…</p></div>}
      {data && 'missing' in data && (
        data.missing === 'baseline' ? (
          <div className="empty">
            <h2>Earned value compares against a baseline</h2>
            <p>Save the plan as it stands as a baseline. From then on this shows whether the work is behind or ahead of it, and over or under its cost.</p>
            <div><button type="button" className="btn" onClick={onSaveBaseline}>Save baseline…</button></div>
          </div>
        ) : (
          <div className="empty">
            <h2>No costs to measure yet</h2>
            <p>Give people a day rate (Resources, in the top bar) or tasks a fixed cost, then save a baseline so it keeps the budget.</p>
            <div><button type="button" className="btn" onClick={onShowCosts}>Show the cost columns</button></div>
          </div>
        )
      )}
      {data && !('missing' in data) && <Report ev={data} />}
    </div>
  );
}

function Report({ ev }: { ev: EarnedValue }) {
  const m = (n: number) => formatMoney(n, ev.currency);
  const notes = [
    ev.estimated ? `Spent is estimated from time worked × day rates for ${ev.estimated} task${ev.estimated === 1 ? '' : 's'}${ev.typed ? `; ${ev.typed} ha${ev.typed === 1 ? 's' : 've'} an actual cost typed in` : ''}.` : '',
    ev.outside ? `${ev.outside} task${ev.outside === 1 ? ' was' : 's were'} added after the baseline, so ${ev.outside === 1 ? 'it has' : 'they have'} no budget in it and ${ev.outside === 1 ? 'is' : 'are'} left out.` : '',
    ev.from_plan ? `The baseline kept no cost for ${ev.from_plan} task${ev.from_plan === 1 ? '' : 's'}, so ${ev.from_plan === 1 ? 'its' : 'their'} budget is today’s cost. Save a new baseline to fix it.` : '',
  ].filter(Boolean);

  return (
    <div className="budget-report">
      <div className="budget-verdicts">
        <p className={`budget-verdict${ev.verdict.schedule.word === 'behind' ? ' is-worse' : ''}`}>{lead(ev.verdict.schedule.text)}</p>
        <p className={`budget-verdict${ev.verdict.cost.word === 'over' ? ' is-worse' : ''}`}>{lead(ev.verdict.cost.text)}</p>
        {ev.verdict.forecast && <p className="budget-verdict">{lead(ev.verdict.forecast)}</p>}
      </div>

      <div className="budget-main">
        <Curve ev={ev} />
        <div className="budget-readout">
          <div className="budget-indices">
            <IndexRow label="Schedule" value={ev.spi} hint="Schedule performance index (SPI): work earned over work planned by now. 1.0 is on plan; below is behind." />
            <IndexRow label="Cost" value={ev.cpi} hint="Cost performance index (CPI): work earned over money spent. 1.0 is on budget; below is over." />
            <p className="budget-hint">1.0 is on plan. Below it is behind, or over.</p>
          </div>
          <dl className="budget-figures">
            <dt title="Budget at completion (BAC): the baseline's cost">Budget</dt><dd>{m(ev.bac)}</dd>
            <dt title="Planned value (PV): the budget of the work planned by the status date">Planned by now</dt><dd>{m(ev.pv)}</dd>
            <dt title="Earned value (EV): the budget of the work actually done">Earned</dt><dd>{m(ev.ev)}</dd>
            <dt title="Actual cost (AC): what the work done cost">Spent</dt><dd>{m(ev.ac)}{ev.estimated ? <span className="budget-est"> est.</span> : null}</dd>
            {ev.eac != null && <><dt title="Estimate at completion (EAC): the budget at today's cost efficiency, BAC ÷ CPI">Forecast</dt><dd>{m(ev.eac)}</dd></>}
          </dl>
        </div>
      </div>

      {ev.summaries.length > 0 && (
        <div className="budget-table-wrap">
          <table className="budget-table">
            <thead>
              <tr>
                <th scope="col">Summary task</th>
                <th scope="col" className="n">Budget</th>
                <th scope="col" className="n">Earned</th>
                <th scope="col" className="n">Spent</th>
                <th scope="col">Schedule</th>
                <th scope="col">Cost</th>
              </tr>
            </thead>
            <tbody>
              {ev.summaries.map((s) => (
                <tr key={s.id}>
                  <th scope="row">{s.name}{s.code != null && <span className="budget-code"> T{s.code}</span>}</th>
                  <td className="n">{m(s.bac)}</td>
                  <td className="n">{m(s.ev)}</td>
                  <td className="n">{m(s.ac)}</td>
                  <td><IndexCell value={s.spi} none={s.pv <= 0 ? 'not started' : '—'} /></td>
                  <td><IndexCell value={s.cpi} none={s.ac <= 0 ? 'nothing spent' : '—'} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {notes.length > 0 && <ul className="budget-notes">{notes.map((n) => <li key={n}>{n}</li>)}</ul>}
    </div>
  );
}

/** The first sentence in bold, the rest plain: "6% behind schedule. Work worth…". */
function lead(text: string) {
  const cut = text.indexOf('. ');
  if (cut < 0) return <strong>{text}</strong>;
  return <><strong>{text.slice(0, cut + 1)}</strong> <span>{text.slice(cut + 2)}</span></>;
}

/** A bullet bar: a track from 0.6 to 1.4, a tick at 1.0, the value as an ink bar. */
function Bullet({ value }: { value: number }) {
  const at = (x: number) => `${Math.max(0, Math.min(1, (x - 0.6) / 0.8)) * 100}%`;
  return (
    <span className={`bullet${value < LOW_INDEX ? ' is-low' : ''}`} aria-hidden="true" style={{ ['--v' as string]: at(value), ['--one' as string]: at(1) } as CSSProperties}>
      <span />
    </span>
  );
}

function IndexRow({ label, value, hint }: { label: string; value: number | null; hint: string }) {
  return (
    <div className="index-row" title={hint}>
      <span>{label}</span>
      {value == null ? <span className="cell-quiet">—</span> : <Bullet value={value} />}
      <span className={`index-value${value != null && value < LOW_INDEX ? ' is-low' : ''}`}>{value == null ? '' : value.toFixed(2)}</span>
    </div>
  );
}

function IndexCell({ value, none }: { value: Figures['spi']; none: string }) {
  if (value == null) return <span className="cell-quiet">{none}</span>;
  return (
    <span className="index-cell">
      <Bullet value={value} />
      <span className={`index-value${value < LOW_INDEX ? ' is-low' : ''}`}>{value.toFixed(2)}</span>
    </span>
  );
}

/**
 * Planned value week by week across the baseline (dashed), and earned and spent
 * at the status date. Earned and spent are only known now, so each is a point,
 * joined to the start by a straight line, and labelled at its end: no legend.
 */
function Curve({ ev }: { ev: EarnedValue }) {
  const m = (n: number) => formatMoney(n, ev.currency);
  const W = 640;
  const H = 280;
  const pad = { l: 64, r: 150, t: 18, b: 30 };
  const end = ev.status_date > ev.finish ? ev.status_date : ev.finish;
  const span = Math.max(1, diffDays(ev.start, end));
  const step = niceStep(Math.max(ev.bac, ev.eac ?? 0, ev.ac) / 4);
  const top = Math.max(step, Math.ceil((Math.max(ev.bac, ev.eac ?? 0, ev.ac) * 1.04) / step) * step);
  const x = (d: ISODate) => pad.l + (Math.max(0, Math.min(span, diffDays(ev.start, d))) / span) * (W - pad.l - pad.r);
  const y = (v: number) => H - pad.b - (v / top) * (H - pad.t - pad.b);
  const pv = ev.series.map((p, i) => `${i ? 'L' : 'M'}${x(p.date).toFixed(1)} ${y(p.pv).toFixed(1)}`).join(' ');
  const sx = x(ev.status_date);
  const x0 = x(ev.start);
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, i) => i * step);
  const months = monthTicks(ev.start, end);
  // Keep the end labels apart when earned and spent sit close together.
  const evY = y(ev.ev);
  const acY = y(ev.ac);
  const apart = Math.abs(evY - acY) < 14 ? (evY > acY ? [7, -7] : [-7, 7]) : [0, 0];

  return (
    <svg className="budget-curve" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`Planned ${m(ev.pv)}, earned ${m(ev.ev)} and spent ${m(ev.ac)} by ${formatDate(ev.status_date)}, of a ${m(ev.bac)} budget`}>
      {ticks.map((v) => (
        <g key={v}>
          <line className="curve-grid" x1={pad.l} x2={W - pad.r} y1={y(v)} y2={y(v)} />
          <text className="curve-tick" x={pad.l - 8} y={y(v) + 4} textAnchor="end">{m(v)}</text>
        </g>
      ))}
      {months.map((d) => <text key={d} className="curve-tick" x={x(d)} y={H - 10} textAnchor="middle">{formatDate(d).split(' ')[1]}</text>)}

      <line className="curve-budget" x1={pad.l} x2={W - pad.r} y1={y(ev.bac)} y2={y(ev.bac)} />
      <text className="curve-end" x={W - pad.r + 8} y={y(ev.bac) + 4}>Budget {m(ev.bac)}</text>
      {/* Spend at today's efficiency: from what is spent now to the forecast at the finish. */}
      {ev.eac != null && ev.status_date < ev.finish && (
        <>
          <line className="curve-forecast" x1={sx} y1={acY} x2={x(ev.finish)} y2={y(ev.eac)} />
          <text className="curve-end" x={W - pad.r + 8} y={y(ev.eac) + 4 + (Math.abs(y(ev.eac) - y(ev.bac)) < 14 ? (ev.eac > ev.bac ? -7 : 7) : 0)}>Forecast {m(ev.eac)}</text>
        </>
      )}

      <path className="curve-pv" d={pv} />
      <text className="curve-label" x={x(ev.finish) - 6} y={y(ev.series.at(-1)?.pv ?? ev.bac) + 16} textAnchor="end">Planned</text>

      <line className="curve-status" x1={sx} x2={sx} y1={pad.t - 6} y2={H - pad.b} />
      <text className="curve-tick" x={sx + 5} y={pad.t}>Status, {formatDate(ev.status_date)}</text>

      <line className="curve-ac" x1={x0} y1={y(0)} x2={sx} y2={acY} />
      <line className="curve-ev" x1={x0} y1={y(0)} x2={sx} y2={evY} />
      <circle className="curve-dot is-ac" cx={sx} cy={acY} r={4} />
      <circle className="curve-dot" cx={sx} cy={evY} r={4} />
      <text className="curve-end" x={sx + 8} y={evY + 4 + apart[0]}>Earned {m(ev.ev)}</text>
      <text className="curve-end" x={sx + 8} y={acY + 4 + apart[1]}>Spent {m(ev.ac)}</text>
    </svg>
  );
}

/** A round step for about four gridlines: 1, 2 or 5 times a power of ten. */
function niceStep(rough: number): number {
  if (!(rough > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(rough));
  const f = rough / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}

/** The first of each month inside the span, bounded. */
function monthTicks(start: ISODate, end: ISODate): ISODate[] {
  const out: ISODate[] = [];
  let y = Number(start.slice(0, 4));
  let mo = Number(start.slice(5, 7));
  for (let guard = 0; guard < 120; guard++) {
    mo++;
    if (mo > 12) { mo = 1; y++; }
    const d = `${y}-${String(mo).padStart(2, '0')}-01`;
    if (d > end) break;
    out.push(d);
  }
  return out.length > 12 ? out.filter((_, i) => i % Math.ceil(out.length / 12) === 0) : out;
}
