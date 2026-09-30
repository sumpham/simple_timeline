import { describe, expect, it } from 'vitest';
import { cleanSettingsPatch, DEFAULT_ASSISTANT_SETTINGS, mergeSettings } from '../shared/assistant/settings.ts';

describe('assistant settings', () => {
  it('defaults to the decided thresholds and sends nothing anywhere', () => {
    expect(DEFAULT_ASSISTANT_SETTINGS).toMatchObject({
      near_critical_days: 2, long_task_days: 20, llm_provider: 'none',
      llm_send_people: false, llm_send_other_projects: false, llm_send_notes: false,
    });
  });

  it('merges stored overrides over the defaults', () => {
    const s = mergeSettings({ long_task_days: 44, llm_model_fast: 'small-model' });
    expect(s.long_task_days).toBe(44);
    expect(s.llm_model_fast).toBe('small-model');
    expect(s.near_critical_days).toBe(2);
  });

  it('reads a stored value that no longer passes its rule as the default', () => {
    expect(mergeSettings({ forecast_runs: 5, llm_provider: 'gone', stray: 1 })).toEqual(DEFAULT_ASSISTANT_SETTINGS);
  });

  it('checks a write, and null resets', () => {
    expect(cleanSettingsPatch({ long_task_days: 30, llm_send_notes: true, forecast_runs: null, llm_model_fast: ' m ' }))
      .toEqual({ set: { long_task_days: 30, llm_send_notes: true, llm_model_fast: 'm' }, reset: ['forecast_runs'] });
  });

  it('refuses unknown keys and bad values, naming them', () => {
    expect(() => cleanSettingsPatch({ nope: 1 })).toThrow('Unknown setting: nope');
    expect(() => cleanSettingsPatch({ long_task_days: 0 })).toThrow(/long_task_days must be a whole number/);
    expect(() => cleanSettingsPatch({ forecast_runs: 1e6 })).toThrow(/forecast_runs/);
    expect(() => cleanSettingsPatch({ llm_provider: 'somewhere' })).toThrow(/llm_provider must be one of none, mock/);
    expect(() => cleanSettingsPatch({ llm_send_notes: 'yes' })).toThrow(/true or false/);
    expect(() => cleanSettingsPatch([])).toThrow('Settings must be an object');
  });
});
