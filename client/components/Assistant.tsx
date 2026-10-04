import type { AssistantReport, Finding, FindingGroup, RuleId } from '../../shared/assistant/rules.ts';
import type { Forecast } from '../../shared/assistant/forecast.ts';
import type { ISODate, PlanImpact } from '../../shared/types.ts';
import type { Advice, Suggestion, SuggestionReport } from '../../shared/assistant/optimise.ts';
import type { MoveKind, PlanOp } from '../../shared/assistant/moves.ts';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { AdvisorReply } from '../../shared/assistant/validate.ts';
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../../shared/assistant/settings.ts';
import { api } from '../api.ts';
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

/**
 * What a warning or a move is about, for the drawer's filter row
 * (reqs/pm_features.md §5.3). Environments: double-bookings. People: who does
 * the work. Dates: everything about when it finishes.
 */
export type Topic = 'all' | 'environments' | 'people' | 'dates';
const TOPIC_LABEL: Record<Topic, string> = { all: 'All', environments: 'Environments', people: 'People', dates: 'Dates' };
const RULE_TOPIC: Record<RuleId, Exclude<Topic, 'all'>> = {
  P1: 'dates', P2: 'dates', P3: 'dates', P4: 'dates', P5: 'dates', P6: 'dates', P7: 'dates', P8: 'dates',
  S1: 'dates', S2: 'dates', S3: 'dates', S4: 'environments', S5: 'people', S6: 'people',
  H1: 'dates', H2: 'dates', H3: 'dates', H4: 'dates', H5: 'dates', H6: 'dates', H7: 'people',
};
const MOVE_TOPIC: Record<MoveKind, Exclude<Topic, 'all'>> = {
  M1: 'environments', M2: 'environments', M3: 'dates', M4: 'dates', M5: 'dates', M6: 'dates', M7: 'dates', MA: 'dates', ML: 'people', MLX: 'people',
};
const suggestionIn = (s: Suggestion, topic: Topic) => topic === 'all' || s.moves.some((m) => MOVE_TOPIC[m.kind] === topic);

export type Level = 'high' | 'medium' | 'low';

/** Severity (likelihood × impact, 1–25) in three words, on the usual matrix bands. */
export function levelOf(severity: number): Level {
  return severity >= 15 ? 'high' : severity >= 8 ? 'medium' : 'low';
}

const LEVEL_LABEL: Record<Level, string> = { high: 'High', medium: 'Medium', low: 'Low' };

export function openFindings(report: AssistantReport | null): Finding[] {
  return report?.findings.filter((f) => !f.dismissed) ?? [];
}

export type BetterPlansProps = {
  report: SuggestionReport | null;
  searching: boolean;
  error: string | null;
  onFind: () => void;
  onPreview: (ops: PlanOp[]) => Promise<PlanImpact | null>;
  onApply: (ops: PlanOp[], version: string, title: string) => void;
  /** Search for levelling moves only: the People filter's Level people. */
  onLevelPeople: () => void;
  /** Open the review page: the to-be plan in full, before Apply (reqs/pm_features.md §8). */
  onReview: (s: Suggestion) => void;
  /** The card last reviewed, brought back into view when the review closes. */
  reviewedId: string | null;
  renderImpact: (impact: PlanImpact) => ReactNode;
};

export type AdvisorProps = {
  reply: AdvisorReply | null;
  asking: boolean;
  error: string | null;
  onAsk: (question: string | null, mode: 'brief' | 'replan') => void;
  /** Settings changed: reload what depends on them. */
  onSettings: () => void;
};

export function AssistantDrawer({
  report, error, busy, target, taskLabel, onClose, onShow, onShowTasks, onDismiss, onRestore, better, advisor,
}: {
  better: BetterPlansProps;
  advisor: AdvisorProps;
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
  const [topic, setTopic] = useState<Topic>('all');
  const inTopic = (f: Finding) => topic === 'all' || RULE_TOPIC[f.rule] === topic;
  const counts = (t: Topic) => open.filter((f) => t === 'all' || RULE_TOPIC[f.rule] === t).length;
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

      {report && (
        <div className="assistant-filters" role="group" aria-label="Show warnings and plans about">
          {(Object.keys(TOPIC_LABEL) as Topic[]).map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={topic === t} onClick={() => setTopic(t)}>
              {TOPIC_LABEL[t]}{counts(t) > 0 && <span className="chip-count">{counts(t)}</span>}
            </button>
          ))}
        </div>
      )}
      {report && topic === 'people' && (
        <div className="assistant-level">
          {!report.findings.some((f) => RULE_TOPIC[f.rule] === 'people' && !f.dismissed) && (
            <p className="drawer-empty">Nobody is on two tasks at once, and critical work has people on it.</p>
          )}
          <button type="button" className="btn" disabled={better.searching || busy} onClick={better.onLevelPeople}
            title="Look for moves that take people off two tasks at once: within float first, then, in the aggressive plan, past it">
            {better.searching ? 'Searching…' : 'Level people'}
          </button>
        </div>
      )}
      {report && topic !== 'all' && topic !== 'people' && !report.findings.some(inTopic) && (
        <p className="drawer-empty">{topic === 'environments' ? 'No double-booking on this plan’s tight work.' : 'Nothing about dates to warn about.'}</p>
      )}

      {report && GROUPS.map((g) => {
        const items = report.findings.filter((f) => f.group === g.id && inTopic(f));
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
      {report && <BetterPlans {...better} topic={topic} busy={busy} onShowTasks={onShowTasks} />}
      {report && (
        <AdvisorSection
          {...advisor}
          on={!!report.advisor?.on}
          provider={report.advisor?.provider ?? 'none'}
          findings={report.findings}
          busy={busy}
          better={better}
          onShowTasks={onShowTasks}
        />
      )}
      {report && <SettingsSection onSaved={advisor.onSettings} />}
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

export const PROFILE_WORD: Record<Suggestion['profile'], string> = {
  safe: 'Safe', balanced: 'Balanced', aggressive: 'Aggressive', tidy: 'Tidy-up', advisor: 'Advisor',
};

/**
 * Better plans (reqs/smart_assistant.md §4.3): found when asked, since the
 * search tries hundreds of plans. Each is the plan's own change ops, previewed
 * by the same impact check as a hand edit and applied through the same path,
 * with Undo. A single move can be taken on its own.
 */
function BetterPlans({
  report, searching, error, busy, onFind, onPreview, onApply, onReview, reviewedId, renderImpact, onShowTasks, topic,
}: BetterPlansProps & { busy: boolean; topic: Topic; onShowTasks: (ids: number[]) => void }) {
  return (
    <section className="better" aria-label="Better plans">
      <h3 className="assistant-group-title">Better plans <span className="drawer-sub">Less risk of delay</span></h3>
      <div className="better-body">
        {!report && (
          <p className="better-intro">
            Tries moves a planner would: level work within its float, switch to a free environment, clear a date that
            holds the critical path, and, when asked for more, overlap or shorten critical work. Nothing changes until you apply it.
          </p>
        )}
        <button type="button" className="btn" disabled={searching || busy} onClick={onFind}>
          {searching ? 'Searching…' : report ? 'Search again' : 'Find a better plan'}
        </button>
        {error && <p className="better-error" role="alert">{error}</p>}
        {report && (
          <p className="better-meta">
            Tried {report.evaluated} plan{report.evaluated === 1 ? '' : 's'}.{' '}
            {!report.suggestions.length && 'None was better without making a new double-booking or a later finish.'}
          </p>
        )}
      </div>
      {report?.suggestions.filter((s) => suggestionIn(s, topic)).map((s) => (
        <SuggestionCard key={s.id} s={s} busy={busy} onPreview={onPreview} onApply={onApply} onReview={onReview} focused={reviewedId === s.id} renderImpact={renderImpact} onShowTasks={onShowTasks} />
      ))}
      {report && report.suggestions.length > 0 && !report.suggestions.some((s) => suggestionIn(s, topic)) && (
        <p className="better-meta better-filtered">None of the plans found is about {TOPIC_LABEL[topic].toLowerCase()}. Choose All to see them.</p>
      )}
      {report && report.tidy.length > 0 && (topic === 'all' || topic === 'dates') && (
        <>
          <h4 className="better-sub">Tidy-ups <span className="drawer-sub">No date moves</span></h4>
          {report.tidy.map((s) => (
            <SuggestionCard key={s.id} s={s} busy={busy} onPreview={onPreview} onApply={onApply} onReview={onReview} focused={reviewedId === s.id} renderImpact={renderImpact} onShowTasks={onShowTasks} />
          ))}
        </>
      )}
      {report && report.advice.length > 0 && (
        <>
          <h4 className="better-sub">Advice <span className="drawer-sub">Not a plan change</span></h4>
          {report.advice.map((a) => <AdviceCard key={a.title} a={a} onShowTasks={onShowTasks} />)}
        </>
      )}
    </section>
  );
}

function effectLine(s: Suggestion): string[] {
  const e = s.effect;
  const out: string[] = [];
  if (e.finish.before && e.finish.after && e.finish.before !== e.finish.after) out.push(`Finish ${formatDate(e.finish.before)} → ${formatDate(e.finish.after)}`);
  if (e.p80 && e.p80.before !== e.p80.after) out.push(`P80 ${formatDate(e.p80.before)} → ${formatDate(e.p80.after)}`);
  if (e.on_time && e.on_time.before != null && e.on_time.after != null && e.on_time.before !== e.on_time.after) {
    out.push(`On time ${pct(e.on_time.before)} → ${pct(e.on_time.after)}`);
  }
  for (const c of e.clashes_cleared) out.push(`Clears ${c.env_name} ${formatDate(c.start_date)} – ${formatDate(c.end_date)}`);
  return out;
}

function SuggestionCard({ s, busy, onPreview, onApply, onReview, focused, renderImpact, onShowTasks }: {
  s: Suggestion;
  busy: boolean;
  onPreview: BetterPlansProps['onPreview'];
  onApply: BetterPlansProps['onApply'];
  onReview: BetterPlansProps['onReview'];
  focused: boolean;
  renderImpact: BetterPlansProps['renderImpact'];
  onShowTasks: (ids: number[]) => void;
}) {
  const [impact, setImpact] = useState<{ at: number; impact: PlanImpact } | null>(null);
  const preview = async (at: number, ops: PlanOp[]) => {
    if (impact?.at === at) { setImpact(null); return; }
    const i = await onPreview(ops);
    if (i) setImpact({ at, impact: i });
  };
  const whole = -1;
  const effect = effectLine(s);
  const reviewRef = useRef<HTMLButtonElement>(null);
  // Back from the review page: the card it came from, in view with Review focused.
  useEffect(() => {
    if (!focused) return;
    reviewRef.current?.scrollIntoView({ block: 'nearest' });
    reviewRef.current?.focus();
  }, [focused]);
  return (
    <article className="suggestion" data-profile={s.profile}>
      <div className="finding-top">
        <span className="finding-title">{s.profile === 'tidy' ? s.title : s.title.replace(/^[A-Z][a-z]+: /, '')}</span>
        <span className="finding-level">{PROFILE_WORD[s.profile]}</span>
      </div>
      {effect.length > 0 && <ul className="finding-evidence suggestion-effect">{effect.map((x) => <li key={x}>{x}</li>)}</ul>}
      <ol className="suggestion-moves">
        {s.moves.map((m, i) => (
          <li key={i}>
            <button type="button" className="link-button suggestion-move" onClick={() => onShowTasks(m.task_ids)}>{m.title}</button>
            <p className="suggestion-reason">{m.reason}</p>
            {m.tradeoff && <p className="suggestion-tradeoff"><strong>Trade-off.</strong> {m.tradeoff}</p>}
            {s.moves.length > 1 && (
              <div className="finding-actions">
                <button type="button" className="btn quiet" disabled={busy} onClick={() => void preview(i, m.ops)} aria-pressed={impact?.at === i}>Preview</button>
                <button type="button" className="btn quiet" disabled={busy} onClick={() => onApply(m.ops, s.version, m.title)}>Apply this move</button>
              </div>
            )}
            {impact && impact.at === i && renderImpact(impact.impact)}
          </li>
        ))}
      </ol>
      {impact?.at === whole && renderImpact(impact.impact)}
      <div className="finding-actions">
        <button type="button" className="btn quiet" disabled={busy} onClick={() => void preview(whole, s.ops)} aria-pressed={impact?.at === whole}>
          Preview{s.moves.length > 1 ? ' all' : ''}
        </button>
        <button type="button" className="btn quiet" disabled={busy} onClick={() => onApply(s.ops, s.version, s.title)}>
          Apply{s.moves.length > 1 ? ` all ${s.moves.length}` : ''}
        </button>
        <button type="button" className="btn" ref={reviewRef} disabled={busy} onClick={() => onReview(s)}
          title="See the whole plan as it would be, then apply">
          Review
        </button>
      </div>
    </article>
  );
}

function AdviceCard({ a, onShowTasks }: { a: Advice; onShowTasks: (ids: number[]) => void }) {
  return (
    <article className="suggestion" data-profile="advice">
      <div className="finding-top"><span className="finding-title">{a.title}</span></div>
      <p className="suggestion-reason">{a.text}</p>
      {a.task_ids.length > 0 && (
        <div className="finding-actions">
          <button type="button" className="btn quiet" onClick={() => onShowTasks(a.task_ids)}>Show task{a.task_ids.length === 1 ? '' : 's'}</button>
        </div>
      )}
    </article>
  );
}

const PROVIDER_LABEL: Record<string, string> = {
  none: 'Off: nothing leaves this machine',
  mock: 'Mock (answers locally, for trying it out)',
  anthropic: 'Anthropic (Claude)',
  'openai-compatible': 'OpenAI-compatible endpoint',
};

/**
 * Ask the advisor (reqs/smart_assistant.md §6). The LLM reads a pruned digest
 * of the plan and answers in words; every number shown is still the engine's,
 * and each move it proposes is kept only if the engine confirms it.
 */
function AdvisorSection({
  on, provider, reply, asking, error, findings, busy, better, onAsk, onShowTasks,
}: AdvisorProps & {
  on: boolean;
  provider: string;
  findings: Finding[];
  busy: boolean;
  better: BetterPlansProps;
  onShowTasks: (ids: number[]) => void;
}) {
  const [question, setQuestion] = useState('');
  const byKey = new Map(findings.map((f) => [f.key, f]));
  return (
    <section className="advisor" aria-label="Ask the advisor">
      <h3 className="assistant-group-title">Advisor <span className="drawer-sub">{on ? PROVIDER_LABEL[provider] ?? provider : 'Off'}</span></h3>
      <div className="better-body">
        {!on ? (
          <p className="better-intro">
            The advisor is an LLM that reads the plan’s names and notes as a PM would, ranks the warnings and proposes moves,
            which the engine then checks. It is off, so nothing leaves this machine. Choose a provider under Settings to turn it on.
          </p>
        ) : (
          <>
            <textarea
              className="advisor-question"
              rows={2}
              maxLength={500}
              value={question}
              placeholder="Ask about the plan, or leave blank for a briefing"
              aria-label="Question for the advisor"
              onChange={(e) => setQuestion(e.target.value)}
            />
            <div className="finding-actions advisor-actions">
              <button type="button" className="btn quiet" disabled={asking || busy} onClick={() => onAsk(question.trim() || null, 'brief')}>
                {asking ? 'Asking…' : 'Ask'}
              </button>
              <button type="button" className="btn" disabled={asking || busy} onClick={() => onAsk(question.trim() || null, 'replan')}
                title="Uses the stronger model and asks for moves">
                Ask for a better plan
              </button>
            </div>
          </>
        )}
        {error && <p className="better-error" role="alert">{error}</p>}
      </div>
      {reply && (
        <div className="advisor-reply">
          <p className="advisor-source">
            {reply.source === 'advisor' ? `Advisor (${reply.provider})${reply.cached ? ', from cache' : ''}` : 'Engine alone'}
            {reply.note && <span className="drawer-sub"> · {reply.note}</span>}
          </p>
          <p className="advisor-briefing">{reply.briefing}</p>
          {reply.risks.length > 0 && (
            <ol className="advisor-risks">
              {reply.risks.slice(0, 6).map((r) => {
                const f = byKey.get(r.key);
                return (
                  <li key={r.key}>
                    {f ? <button type="button" className="link-button" onClick={() => onShowTasks(f.task_ids)}>{f.title}</button> : r.key}
                    {reply.source === 'advisor' && <span className="suggestion-reason"> {r.why}</span>}
                  </li>
                );
              })}
            </ol>
          )}
          {reply.suggestions.map((s) => (
            <SuggestionCard key={s.id} s={s} busy={busy} onPreview={better.onPreview} onApply={better.onApply} onReview={better.onReview} focused={better.reviewedId === s.id} renderImpact={better.renderImpact} onShowTasks={onShowTasks} />
          ))}
          {reply.rejected.length > 0 && (
            <details className="advisor-rejected">
              <summary>The engine dropped {reply.rejected.length} of the advisor’s move{reply.rejected.length === 1 ? '' : 's'}</summary>
              <ul>{reply.rejected.map((r, i) => <li key={i}>{r.title}: {r.reason}.</li>)}</ul>
            </details>
          )}
          {reply.usage && (
            <p className="better-meta">
              About {reply.usage.prompt_tokens.toLocaleString()} tokens of plan and rubric; {reply.usage.input.toLocaleString()} in
              {reply.usage.cacheRead ? ` (${reply.usage.cacheRead.toLocaleString()} from cache)` : ''}, {reply.usage.output.toLocaleString()} out
              {reply.usage.turns ? `, ${reply.usage.turns} tool turn${reply.usage.turns === 1 ? '' : 's'}` : ''}.
              Showed {reply.usage.shown} of {reply.usage.total} tasks.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

type SettingsDraft = Partial<{ [K in keyof AssistantSettings]: AssistantSettings[K] | null }>;

/** The assistant's settings: thresholds, the forecast, and the advisor's provider and privacy. */
function SettingsSection({ onSaved }: { onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [s, setS] = useState<AssistantSettings | null>(null);
  const [providers, setProviders] = useState<{ id: string; ready: boolean; note: string | null }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    api.assistantSettings().then(setS).catch((e) => setError(String(e.message ?? e)));
    api.assistantProviders().then(setProviders).catch(() => setProviders([]));
  }, [open]);

  const save = async (patch: SettingsDraft) => {
    setSaving(true);
    try {
      setS(await api.updateAssistantSettings(patch));
      setError(null);
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not save'); } finally { setSaving(false); }
  };
  const num = (key: 'near_critical_days' | 'long_task_days' | 'forecast_runs' | 'llm_token_budget', label: string, hint: string) => (
    <label className="stack settings-field">
      {label}
      <input
        inputMode="numeric"
        defaultValue={s ? String(s[key]) : ''}
        key={`${key}:${s?.[key]}`}
        onBlur={(e) => { const n = Number(e.target.value); if (Number.isInteger(n) && n !== s?.[key]) void save({ [key]: n }); }}
      />
      <span className="field-hint">{hint} Default {DEFAULT_ASSISTANT_SETTINGS[key].toLocaleString()}.</span>
    </label>
  );
  const flag = (key: 'llm_send_people' | 'llm_send_other_projects' | 'llm_send_notes', label: string) => (
    <label className="check">
      <input type="checkbox" checked={!!s?.[key]} disabled={saving} onChange={(e) => void save({ [key]: e.target.checked })} />
      <span>{label}</span>
    </label>
  );
  const ready = providers.find((p) => p.id === s?.llm_provider);

  return (
    <details className="assistant-settings" open={open} onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}>
      <summary className="assistant-group-title">Settings</summary>
      {s && (
        <div className="better-body settings-body">
          {num('near_critical_days', 'Near-critical within (working days)', 'Float at or under this is close to critical.')}
          {num('long_task_days', 'Long task over (working days)', 'The 8/80 rule; DCMA uses 44.')}
          {num('forecast_runs', 'Forecast runs', 'More runs, steadier percentages; 100 to 10,000.')}
          <label className="stack settings-field">
            Advisor
            <select value={s.llm_provider} disabled={saving} onChange={(e) => void save({ llm_provider: e.target.value as AssistantSettings['llm_provider'] })}>
              {['none', 'mock', 'anthropic', 'openai-compatible'].map((id) => <option key={id} value={id}>{PROVIDER_LABEL[id]}</option>)}
            </select>
            <span className="field-hint">
              {ready && !ready.ready ? ready.note : s.llm_provider === 'none'
                ? 'The engine answers on its own.'
                : 'The endpoint and key come from the server’s environment (ASSISTANT_LLM_URL, ASSISTANT_LLM_KEY), never from here.'}
            </span>
          </label>
          {s.llm_provider !== 'none' && (
            <>
              <label className="stack settings-field">
                Model for briefings
                <input defaultValue={s.llm_model_fast ?? ''} key={`f:${s.llm_model_fast}`} placeholder="Provider default"
                  onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== s.llm_model_fast) void save({ llm_model_fast: v }); }} />
              </label>
              <label className="stack settings-field">
                Model for better plans
                <input defaultValue={s.llm_model_strong ?? ''} key={`s:${s.llm_model_strong}`} placeholder="Provider default"
                  onBlur={(e) => { const v = e.target.value.trim() || null; if (v !== s.llm_model_strong) void save({ llm_model_strong: v }); }} />
              </label>
              {num('llm_token_budget', 'Token budget per ask', 'The plan is pruned until it fits.')}
              <fieldset className="settings-privacy">
                <legend>What may leave this machine</legend>
                <span className="field-hint">Task names, dates and environments always do. Off, these are sent as R1, O1 or not at all.</span>
                {flag('llm_send_people', 'People’s names')}
                {flag('llm_send_other_projects', 'Other projects’ names')}
                {flag('llm_send_notes', 'Task notes')}
              </fieldset>
            </>
          )}
          {error && <p className="better-error" role="alert">{error}</p>}
        </div>
      )}
    </details>
  );
}
