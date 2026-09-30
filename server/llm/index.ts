import type { AssistantSettings, LlmProviderId } from '../../shared/assistant/settings.ts';
import type { LlmProvider } from './provider.ts';
import { noneProvider } from './providers/none.ts';
import { mockProvider } from './providers/mock.ts';

/**
 * The provider settings ask for. A real provider reads its endpoint and key from
 * the environment only (ASSISTANT_LLM_URL, ASSISTANT_LLM_KEY), never from
 * settings or the database; without them it is `none`, with the reason given.
 */

type Factory = (env: { url: string | null; key: string | null }) => LlmProvider | string;

const factories: Partial<Record<LlmProviderId, Factory>> = {
  none: () => noneProvider,
  mock: () => mockProvider(),
};

/** Add a provider adapter (server/llm/providers/<name>.ts registers itself here). */
export function registerProvider(id: LlmProviderId, factory: Factory) {
  factories[id] = factory;
}

function env() {
  return { url: process.env.ASSISTANT_LLM_URL?.trim() || null, key: process.env.ASSISTANT_LLM_KEY?.trim() || null };
}

export function providerFor(settings: AssistantSettings): { provider: LlmProvider; note: string | null } {
  const make = factories[settings.llm_provider];
  if (!make) return { provider: noneProvider, note: `The ${settings.llm_provider} provider is not built into this server.` };
  const made = make(env());
  return typeof made === 'string' ? { provider: noneProvider, note: made } : { provider: made, note: null };
}

/** Which providers could answer now, and why not, for the settings form. Never reveals the key. */
export function providerStatus(): { id: LlmProviderId; ready: boolean; note: string | null }[] {
  const e = env();
  return (Object.keys(factories) as LlmProviderId[]).map((id) => {
    const made = factories[id]!(e);
    return { id, ready: typeof made !== 'string', note: typeof made === 'string' ? made : null };
  });
}
