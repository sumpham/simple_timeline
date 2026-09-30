/**
 * The seam between the assistant and any LLM (reqs/smart_assistant.md §6.3). An
 * adapter implements `LlmProvider` for one API and nothing else: the prompt, the
 * tools, the budget, validation and fallback all live in front of it, in
 * orchestrate.ts and shared/assistant/. Code never names a model: a request asks
 * for a tier, and settings say which model that is.
 */

/** Part of a prompt. `stable` parts come first and may be cached by the provider; `volatile` ones change per call. */
export type Segment = { text: string; cache: 'stable' | 'volatile' };

export type ToolSpec = { name: string; description: string; input_schema: object };
export type ToolCall = { id: string; name: string; args: unknown };

export type LlmMessage =
  | { role: 'user'; content: Segment[] }
  | { role: 'assistant'; text?: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; results: { id: string; name: string; content: string }[] };

export type LlmRequest = {
  tier: 'fast' | 'strong';
  /** The tier's model from settings; null lets the provider use its default. */
  model: string | null;
  system: Segment[];
  messages: LlmMessage[];
  tools?: ToolSpec[];
  /** The answer's JSON schema; a provider that cannot enforce it is asked for JSON in words. */
  output: object;
  maxOutputTokens: number;
};

export type LlmUsage = { input: number; output: number; cacheRead?: number; cacheWrite?: number };

export type LlmResponse = {
  /** The answer when the provider returned structured output. */
  json?: unknown;
  text?: string;
  toolCalls?: ToolCall[];
  usage: LlmUsage;
  model?: string;
};

export type LlmCaps = { tools: boolean; jsonSchema: boolean; promptCache: boolean; countTokens: boolean };

export interface LlmProvider {
  readonly id: string;
  readonly caps: LlmCaps;
  complete(req: LlmRequest, signal: AbortSignal): Promise<LlmResponse>;
  countTokens?(req: LlmRequest): Promise<number>;
}

/** The provider cannot answer (none chosen, no key, offline). The assistant falls back to the engine. */
export class LlmUnavailable extends Error {}
