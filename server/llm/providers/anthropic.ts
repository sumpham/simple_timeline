import Anthropic from '@anthropic-ai/sdk';
import { LlmUnavailable, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse, type Segment } from '../provider.ts';
import { portableSchema } from '../schema.ts';

/**
 * Claude through the official Anthropic SDK (Messages API).
 *
 * - The rubric and the network go in `system` as text blocks, with a cache
 *   breakpoint on the last stable one, so every later ask reads them from cache.
 * - Tools are the engine's (get_task, simulate); tool_use / tool_result blocks
 *   carry the loop. The assistant's own content is echoed back unchanged, since
 *   it can hold thinking blocks that must be.
 * - The answer is constrained by `output_config.format` (a JSON schema).
 * - On Claude Opus 5 and Claude Fable 5.1, a declined request is re-run
 *   server-side on a fallback model (`fallbacks: "default"`) instead of failing.
 *
 * Key: ASSISTANT_LLM_KEY (or the SDK's own ANTHROPIC_API_KEY). ASSISTANT_LLM_URL,
 * when set, points the SDK at a gateway instead of api.anthropic.com.
 */

export const ANTHROPIC_DEFAULT_MODEL = 'claude-opus-5';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** Models that take server-side refusal fallbacks in "default" mode. */
const FALLBACK_MODELS = /^claude-(opus-5|fable-5-1)$/;
/** Effort is not accepted by Haiku 4.5 or pre-4.5 Sonnets. */
const NO_EFFORT = /haiku|sonnet-4-5|claude-3/;

type Client = Pick<Anthropic, 'beta' | 'messages'>;

function systemBlocks(segments: Segment[]): Anthropic.Beta.BetaTextBlockParam[] {
  const lastStable = segments.map((s) => s.cache).lastIndexOf('stable');
  return segments.map((s, i) => (i === lastStable
    ? { type: 'text' as const, text: s.text, cache_control: { type: 'ephemeral' as const } }
    : { type: 'text' as const, text: s.text }));
}

function messagesOf(messages: LlmMessage[]): Anthropic.Beta.BetaMessageParam[] {
  return messages.map((m): Anthropic.Beta.BetaMessageParam => {
    if (m.role === 'user') return { role: 'user', content: m.content.map((s) => ({ type: 'text' as const, text: s.text })) };
    if (m.role === 'tool') {
      return { role: 'user', content: m.results.map((r) => ({ type: 'tool_result' as const, tool_use_id: r.id, content: r.content })) };
    }
    if (m.raw) return { role: 'assistant', content: m.raw as Anthropic.Beta.BetaContentBlockParam[] };
    return {
      role: 'assistant',
      content: [
        ...(m.text ? [{ type: 'text' as const, text: m.text }] : []),
        ...(m.toolCalls ?? []).map((c) => ({ type: 'tool_use' as const, id: c.id, name: c.name, input: c.args as Record<string, unknown> })),
      ],
    };
  });
}

export function requestOf(req: LlmRequest): Anthropic.Beta.MessageCreateParamsNonStreaming {
  const model = req.model ?? ANTHROPIC_DEFAULT_MODEL;
  const fallback = FALLBACK_MODELS.test(model);
  return {
    model,
    max_tokens: Math.max(req.maxOutputTokens, 4000),
    system: systemBlocks(req.system),
    messages: messagesOf(req.messages),
    ...(req.tools?.length ? {
      tools: req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: portableSchema(t.input_schema) as Anthropic.Beta.BetaTool.InputSchema })),
    } : {}),
    output_config: {
      format: { type: 'json_schema', schema: portableSchema(req.output) as Record<string, unknown> },
      // A briefing is routine work; a re-plan earns more thought.
      ...(NO_EFFORT.test(model) ? {} : { effort: req.tier === 'strong' ? 'high' : 'medium' }),
    },
    ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
  } as Anthropic.Beta.MessageCreateParamsNonStreaming;
}

export function responseOf(msg: Anthropic.Beta.BetaMessage): LlmResponse {
  if (msg.stop_reason === 'refusal') throw new Error('The model declined to answer');
  const text = msg.content.filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === 'text').map((b) => b.text).join('');
  const toolCalls = msg.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, args: b.input }));
  if (msg.stop_reason === 'max_tokens') throw new Error('The answer was cut off at its token limit');
  let json: unknown;
  if (!toolCalls.length && text) {
    try { json = JSON.parse(text); } catch { /* left to checkAnswer and the repair turn */ }
  }
  const u = msg.usage;
  return {
    text: text || undefined,
    json,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: msg.content,
    model: msg.model,
    usage: {
      input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
      output: u.output_tokens ?? 0,
      cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0,
    },
  };
}

export function anthropicProvider(opts: { key?: string | null; url?: string | null; client?: Client }): LlmProvider {
  const client: Client = opts.client ?? new Anthropic({
    ...(opts.key ? { apiKey: opts.key } : {}),
    ...(opts.url ? { baseURL: opts.url } : {}),
  });
  return {
    id: 'anthropic',
    caps: { tools: true, jsonSchema: true, promptCache: true, countTokens: true },
    async complete(req, signal) {
      try {
        return responseOf(await client.beta.messages.create(requestOf(req), { signal }) as Anthropic.Beta.BetaMessage);
      } catch (err) {
        if (err instanceof Anthropic.AuthenticationError) throw new LlmUnavailable('The Anthropic API key was refused');
        if (err instanceof Anthropic.PermissionDeniedError) throw new LlmUnavailable('The Anthropic key may not use that model');
        if (err instanceof Anthropic.APIConnectionError) throw new LlmUnavailable('Cannot reach the Anthropic API from this machine');
        if (err instanceof Anthropic.APIError) throw new Error(`The Anthropic API answered ${err.status}: ${err.message}`);
        throw err;
      }
    },
    async countTokens(req) {
      const { model, system, messages, tools } = requestOf(req);
      const r = await client.messages.countTokens({
        model, system: system as Anthropic.TextBlockParam[], messages: messages as Anthropic.MessageParam[],
        ...(tools ? { tools: tools as Anthropic.Tool[] } : {}),
      });
      return r.input_tokens;
    },
  };
}
