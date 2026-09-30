/**
 * The assistant's settings (reqs/smart_assistant.md §8.1, §9): thresholds for the
 * rules, the forecast's run count, and the LLM seam. Pure, so the server checks a
 * write with the same rules a settings form would.
 *
 * Only values someone changed are stored (`assistant_setting`); a read merges them
 * over these defaults, so a new setting needs no migration. The LLM endpoint and
 * key are never settings: they come from the server's environment only.
 */

/** Providers the server knows. 'none' sends nothing anywhere; 'mock' answers locally, for tests. */
export const LLM_PROVIDERS = ['none', 'mock'] as const;
export type LlmProviderId = (typeof LLM_PROVIDERS)[number];

export type AssistantSettings = {
  /** A task with total float at or below this many working days is near-critical (rule S1). */
  near_critical_days: number;
  /** A task longer than this many working days should be split (rule H5; the 8/80 rule). */
  long_task_days: number;
  /** Monte Carlo runs per forecast. Bounded: every assistant loop is. */
  forecast_runs: number;
  llm_provider: LlmProviderId;
  /** The model behind each tier; null leaves it to the provider's default. Code never names a model. */
  llm_model_fast: string | null;
  llm_model_strong: string | null;
  /** Input tokens a request may use; the digest tightens until it fits. */
  llm_token_budget: number;
  /** What may leave the machine. All off is the strictest, and the default. */
  llm_send_people: boolean;
  llm_send_other_projects: boolean;
  llm_send_notes: boolean;
};

export const DEFAULT_ASSISTANT_SETTINGS: Readonly<AssistantSettings> = Object.freeze({
  near_critical_days: 2,
  long_task_days: 20,
  forecast_runs: 1000,
  llm_provider: 'none',
  llm_model_fast: null,
  llm_model_strong: null,
  llm_token_budget: 6000,
  llm_send_people: false,
  llm_send_other_projects: false,
  llm_send_notes: false,
});

export type SettingKey = keyof AssistantSettings;

type Rule = (value: unknown) => unknown;

const int = (min: number, max: number): Rule => (v) => {
  if (!Number.isInteger(v) || (v as number) < min || (v as number) > max) throw new Error(`must be a whole number from ${min} to ${max}`);
  return v;
};
const bool: Rule = (v) => {
  if (typeof v !== 'boolean') throw new Error('must be true or false');
  return v;
};
const modelName: Rule = (v) => {
  if (v === null) return null;
  if (typeof v !== 'string' || !v.trim() || v.trim().length > 100) throw new Error('must be a model name of up to 100 characters, or null');
  return v.trim();
};
const provider: Rule = (v) => {
  if (!LLM_PROVIDERS.includes(v as LlmProviderId)) throw new Error(`must be one of ${LLM_PROVIDERS.join(', ')}`);
  return v;
};

const RULES: Record<SettingKey, Rule> = {
  near_critical_days: int(0, 60),
  long_task_days: int(1, 500),
  forecast_runs: int(100, 10000),
  llm_provider: provider,
  llm_model_fast: modelName,
  llm_model_strong: modelName,
  llm_token_budget: int(1000, 200000),
  llm_send_people: bool,
  llm_send_other_projects: bool,
  llm_send_notes: bool,
};

export const isSettingKey = (key: string): key is SettingKey => Object.hasOwn(RULES, key);

/**
 * A settings write, checked. A value of undefined is ignored; null resets a
 * setting to its default (`reset`), except where null is itself a value (the
 * model names), which then also resets. Throws, naming the setting, on the first
 * bad key or value.
 */
export function cleanSettingsPatch(patch: unknown): { set: Partial<AssistantSettings>; reset: SettingKey[] } {
  if (patch == null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Settings must be an object');
  const set: Record<string, unknown> = {};
  const reset: SettingKey[] = [];
  for (const [key, value] of Object.entries(patch)) {
    if (!isSettingKey(key)) throw new Error(`Unknown setting: ${key}`);
    if (value === undefined) continue;
    if (value === null) {
      reset.push(key);
      continue;
    }
    try {
      set[key] = RULES[key](value);
    } catch (err) {
      throw new Error(`${key} ${(err as Error).message}`);
    }
  }
  return { set: set as Partial<AssistantSettings>, reset };
}

/**
 * Stored overrides merged over the defaults. A stored value that no longer
 * passes its rule (a setting's range tightened since) reads as the default, so a
 * bad row can never reach the engine.
 */
export function mergeSettings(stored: Readonly<Record<string, unknown>>): AssistantSettings {
  const out: Record<string, unknown> = { ...DEFAULT_ASSISTANT_SETTINGS };
  for (const [key, value] of Object.entries(stored)) {
    if (!isSettingKey(key)) continue;
    try {
      out[key] = RULES[key](value);
    } catch {
      // Keep the default.
    }
  }
  return out as AssistantSettings;
}
