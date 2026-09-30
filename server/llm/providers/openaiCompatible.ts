import { LlmUnavailable, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse } from '../provider.ts';
import { portableSchema } from '../schema.ts';

/**
 * Any chat-completions endpoint: OpenAI, Azure OpenAI, a company gateway, or a
 * local model server (Ollama, LM Studio, vLLM). Plain fetch, since each of these
 * speaks the same wire format and there is no one SDK for all of them.
 *
 * ASSISTANT_LLM_URL is the full chat-completions URL. ASSISTANT_LLM_KEY is sent
 * as a bearer token when set (a local server may need none). A model must be
 * named in settings. Prefix caching is automatic on the services that have it,
 * so the stable-first prompt order is all this adapter needs to do for it. A
 * server that rejects `response_format` is asked again without it; the answer
 * is still checked against its schema.
 */

type Fetch = typeof fetch;

type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

function messagesOf(req: LlmRequest): ChatMessage[] {
  const out: ChatMessage[] = [{ role: 'system', content: req.system.map((s) => s.text).join('\n\n') }];
  for (const m of req.messages as LlmMessage[]) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content.map((s) => s.text).join('\n\n') });
    else if (m.role === 'tool') for (const r of m.results) out.push({ role: 'tool', tool_call_id: r.id, content: r.content });
    else {
      out.push({
        role: 'assistant',
        content: m.text ?? null,
        ...(m.toolCalls?.length ? {
          tool_calls: m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } })),
        } : {}),
      });
    }
  }
  return out;
}

export function bodyOf(req: LlmRequest, model: string, withFormat: boolean) {
  return {
    model,
    messages: messagesOf(req),
    max_tokens: req.maxOutputTokens,
    ...(req.tools?.length ? {
      tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: portableSchema(t.input_schema) } })),
    } : {}),
    ...(withFormat ? { response_format: { type: 'json_schema', json_schema: { name: 'advisor_answer', schema: portableSchema(req.output) } } } : {}),
  };
}

type ChatResponse = {
  model?: string;
  choices?: { finish_reason?: string; message?: { content?: string | null; tool_calls?: { id: string; function: { name: string; arguments: string } }[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
};

export function responseOf(r: ChatResponse): LlmResponse {
  const choice = r.choices?.[0];
  if (!choice?.message) throw new Error('The endpoint returned no answer');
  if (choice.finish_reason === 'length') throw new Error('The answer was cut off at its token limit');
  const text = choice.message.content ?? undefined;
  const toolCalls = (choice.message.tool_calls ?? []).map((c) => {
    let args: unknown = {};
    try { args = JSON.parse(c.function.arguments || '{}'); } catch { args = { invalid: c.function.arguments }; }
    return { id: c.id, name: c.function.name, args };
  });
  let json: unknown;
  if (!toolCalls.length && text) {
    try { json = JSON.parse(text); } catch { /* left to checkAnswer */ }
  }
  return {
    text, json, toolCalls: toolCalls.length ? toolCalls : undefined, model: r.model,
    usage: { input: r.usage?.prompt_tokens ?? 0, output: r.usage?.completion_tokens ?? 0, cacheRead: r.usage?.prompt_tokens_details?.cached_tokens ?? 0 },
  };
}

export function openaiCompatibleProvider(opts: { url: string; key?: string | null; fetch?: Fetch }): LlmProvider {
  const doFetch = opts.fetch ?? fetch;
  let formatRefused = false;
  const post = async (body: unknown, signal: AbortSignal) => {
    try {
      return await doFetch(opts.url, {
        method: 'POST',
        signal,
        headers: { 'content-type': 'application/json', ...(opts.key ? { authorization: `Bearer ${opts.key}` } : {}) },
        body: JSON.stringify(body),
      });
    } catch (err) {
      if (signal.aborted) throw err;
      throw new LlmUnavailable(`Cannot reach ${new URL(opts.url).host} from this machine`);
    }
  };
  return {
    id: 'openai-compatible',
    caps: { tools: true, jsonSchema: true, promptCache: true, countTokens: false },
    async complete(req, signal) {
      if (!req.model) throw new LlmUnavailable('Name a model for the OpenAI-compatible endpoint in the assistant settings');
      let res = await post(bodyOf(req, req.model, !formatRefused), signal);
      if (res.status === 400 && !formatRefused) {
        const text = await res.text();
        if (/response_format|json_schema/i.test(text)) {
          formatRefused = true;
          res = await post(bodyOf(req, req.model, false), signal);
        } else {
          throw new Error(`The endpoint answered 400: ${text.slice(0, 200)}`);
        }
      }
      if (res.status === 401 || res.status === 403) throw new LlmUnavailable('The endpoint refused the key');
      if (!res.ok) throw new Error(`The endpoint answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return responseOf(await res.json() as ChatResponse);
    },
  };
}
