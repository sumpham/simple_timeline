import type { AssistantReport, Finding, FindingGroup } from '../../shared/assistant/rules.ts';
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
  report, error, busy, onClose, onShow, onDismiss, onRestore,
}: {
  report: AssistantReport | null;
  error: string | null;
  busy: boolean;
  onClose: () => void;
  onShow: (f: Finding) => void;
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
