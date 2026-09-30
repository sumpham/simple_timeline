import type { AssistantReport, Finding, FindingGroup } from '../../shared/assistant/rules.ts';
import type { Forecast } from '../../shared/assistant/forecast.ts';
import type { ISODate } from '../../shared/types.ts';
import { formatDate } from '../layout.ts';

/**
 * The assistant's warnings for one plan (reqs/smart_assistant.md §4.1). Every
 * number in it comes from the engine in shared/assistant/; this only lays them
 * out. Colour is not spent here: severity is weight and a word, so `--alarm`
 * stays on double-bookings.
 */

const GROUPS: { id: FindingGroup; title: string; hint: string }[] = [
  { id: 'progress', title: 'Progress', hint: 'Is it slipping now?' },
  { id: 'structure', title: 'Structure', hint: 'Will the plan hold up?' },
  { id: 'hygiene', title: 'Schedule checks', hint: 'Can its dates be trusted?' },
];

export type Level = 'high' | 'medium' | 'low';

/** Severity (likelihood × impact, 1–25) in three words, on the usual matrix bands. */
export function levelOf(severity: number): Level {
  return severity >= 15 ? 'high' : severity >= 8 ? 'medium' : 'low';
}

const LEVEL_LABEL: Record<Level, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function openFindings(report: AssistantReport | null): Finding[] {
  return report?.findings.filter((f) => !f.dismissed) ?? [];
}

export function AssistantDrawer({
  report, error, busy, target, taskLabel, onClose, onShow, onShowTasks, onDismiss, onRestore,
}: {
  report: AssistantReport | null;
  error: string | null;
  busy: boolean;
  target: ISODate | null;
  /** "Build API (T12)" for a task id. */
  taskLabel: (id: number) => string;
  onClose: () => void;
  onShow: (f: Finding) => void;
  onShowTasks: (ids: number[]) => void;
  onDismiss: (f: Finding) => void;
  onRestore: (f: Finding) => void;
}) {
  const open = openFindings(report);
  return (
    <aside className="drawer assistant" aria-label="Assistant">
      <div className="drawer-head">
        <h2 className="drawer-title">
          Assistant{' '}
          {report && <span className="drawer-sub">as of {formatDate(report.status_date)}</span>}
        </h2>
        <button type="button" className="link-button" onClick={onClose}>Close</button>
      </div>

      {error && <p className="drawer-empty" role="alert">{error}</p>}
      {report?.forecast && <ForecastCard forecast={report.forecast} target={target} taskLabel={taskLabel} onShowTasks={onShowTasks} />}
      {!report && !error && <p className="drawer-empty">Reading the plan…</p>}
      {report && !report.findings.length && (
        <p className="drawer-empty">
          Nothing to warn about. The plan has no slipping work, no clash on its tight paths, and its links hold together.
        </p>
      )}
      {report && report.findings.length > 0 && !open.length && (
        <p className="drawer-empty">Every warning has been set aside. They come back if what they concern changes.</p>
      )}

      {report && GROUPS.map((g) => {
        const items = report.findings.filter((f) => f.group === g.id);
        if (!items.length) return null;
        // Set-aside warnings sink below the live ones, as resolved clashes stay listed but quiet.
        const sorted = [...items.filter((f) => !f.dismissed), ...items.filter((f) => f.dismissed)];
        return (
          <section key={g.id} className="assistant-group" aria-label={g.title}>
            <h3 className="assistant-group-title">{g.title} <span className="drawer-sub">{g.hint}</span></h3>
            {sorted.map((f) => (
              <FindingCard key={f.key} finding={f} busy={busy} onShow={onShow} onDismiss={onDismiss} onRestore={onRestore} />
            ))}
          </section>
        );
      })}
    </aside>
  );
}

function FindingCard({ finding: f, busy, onShow, onDismiss, onRestore }: {
  finding: Finding;
  busy: boolean;
  onShow: (f: Finding) => void;
  onDismiss: (f: Finding) => void;
  onRestore: (f: Finding) => void;
}) {
  const level = levelOf(f.severity);
  return (
    <article className={`finding${f.dismissed ? ' is-dismissed' : ''}`} data-level={level}>
      <div className="finding-top">
        <span className="finding-title">{f.title}</span>
        <span className="finding-level" title={`Likelihood ${f.likelihood} × impact ${f.impact}`}>
          {f.dismissed ? 'Set aside' : LEVEL_LABEL[level]}
        </span>
      </div>
      <p className="finding-text">{f.text}</p>
      {f.evidence.length > 0 && (
        <ul className="finding-evidence">
          {f.evidence.map((e) => <li key={e}>{e}</li>)}
        </ul>
      )}
      <div className="finding-actions">
        <span className="finding-rule">{f.rule}</span>
        {f.task_ids.length > 0 && (
          <button type="button" className="btn quiet" onClick={() => onShow(f)}>
            Show {f.task_ids.length === 1 ? 'task' : `${f.task_ids.length} tasks`}
          </button>
        )}
        {f.dismissed
          ? <button type="button" className="btn quiet" disabled={busy} onClick={() => onRestore(f)}>Bring back</button>
          : <button type="button" className="btn quiet" disabled={busy} onClick={() => onDismiss(f)}>Set aside</button>}
      </div>
    </article>
  );
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

/**
 * The forecast in a PM's words: the chance of meeting the target, the finishes
 * at 50% and 80% confidence, and which tasks decide it. Numbers are the
 * engine's; the only emphasis is size.
 */
function ForecastCard({ forecast: f, target, taskLabel, onShowTasks }: {
  forecast: Forecast;
  target: ISODate | null;
  taskLabel: (id: number) => string;
  onShowTasks: (ids: number[]) => void;
}) {
  const often = f.criticality.filter((c) => c.index >= 0.3).slice(0, 4);
  const drivers = f.sensitivity.slice(0, 3);
  return (
    <section className="forecast" aria-label="Forecast">
      <h3 className="assistant-group-title">Forecast <span className="drawer-sub">{f.runs.toLocaleString()} simulated runs</span></h3>
      <div className="forecast-body">
        {f.on_time != null && target ? (
          <p className="forecast-headline">
            <span className="forecast-big">{pct(f.on_time)}</span>
            chance of finishing by the target, {formatDate(target)}
          </p>
        ) : (
          <p className="forecast-headline forecast-none">Set a target date to see the chance of meeting it.</p>
        )}
        <dl className="forecast-dates">
          <div><dt>Planned</dt><dd>{formatDate(f.planned)}</dd></div>
          {f.deterministic !== f.planned && <div><dt title="With unfinished work moved to start no earlier than today">From today</dt><dd>{formatDate(f.deterministic)}</dd></div>}
          <div><dt title="Half the runs finish by then">P50</dt><dd>{formatDate(f.p50)}</dd></div>
          <div><dt title="Four in five runs finish by then: a date to promise">P80</dt><dd>{formatDate(f.p80)}</dd></div>
        </dl>
        {often.length > 0 && (
          <div className="forecast-list">
            <span className="forecast-label">Often on the critical path</span>
            <ul>{often.map((c) => <li key={c.id}><button type="button" className="link-button" onClick={() => onShowTasks([c.id])}>{taskLabel(c.id)}</button> <span className="forecast-num">{pct(c.index)}</span></li>)}</ul>
          </div>
        )}
        {drivers.length > 0 && (
          <div className="forecast-list">
            <span className="forecast-label">Moves the finish most</span>
            <ul>{drivers.map((c) => <li key={c.id}><button type="button" className="link-button" onClick={() => onShowTasks([c.id])}>{taskLabel(c.id)}</button> <span className="forecast-num" title="Correlation of its length with the finish">{c.correlation.toFixed(2)}</span></li>)}</ul>
          </div>
        )}
        {f.defaulted_critical.length > 0 && (
          <p className="forecast-note">
            {f.defaulted_critical.length} critical task{f.defaulted_critical.length === 1 ? ' uses' : 's use'} the default range (10% under, 30% over).
            Give {f.defaulted_critical.length === 1 ? 'it' : 'them'} a best and worst case for a sharper forecast.{' '}
            <button type="button" className="link-button" onClick={() => onShowTasks(f.defaulted_critical)}>Show</button>
          </p>
        )}
      </div>
    </section>
  );
}
