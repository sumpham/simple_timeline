import { LlmUnavailable, type LlmProvider } from '../provider.ts';

/** The default: nothing leaves the machine. Every ask falls back to the engine's own answer. */
export const noneProvider: LlmProvider = {
  id: 'none',
  caps: { tools: false, jsonSchema: false, promptCache: false, countTokens: false },
  async complete() {
    throw new LlmUnavailable('No LLM provider is turned on. The engine answered on its own.');
  },
};
