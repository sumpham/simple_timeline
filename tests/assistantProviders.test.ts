import { describe, expect, it } from 'vitest';
import { anthropicProvider, requestOf } from '../server/llm/providers/anthropic.ts';
import { openaiCompatibleProvider } from '../server/llm/providers/openaiCompatible.ts';
import { portableSchema } from '../server/llm/schema.ts';
import { ask } from '../server/llm/orchestrate.ts';
import { LlmUnavailable, type LlmRequest } from '../server/llm/provider.ts';
import { ANSWER_SCHEMA, TOOLS } from '../shared/assistant/validate.ts';

const signal = new AbortController().signal;
const tools = TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema }));
const req = (over: Partial<LlmRequest> = {}): LlmRequest => ({
  tier: 'fast', model: null, maxOutputTokens: 1500, output: ANSWER_SCHEMA, tools,
  system: [{ text: 'RUBRIC', cache: 'stable' }, { text: 'NETWORK', cache: 'stable' }],
  messages: [{ role: 'user', content: [{ text: 'STATE', cache: 'volatile' }] }],
  ...over,
});
const answer = { briefing: 'Act on T3 first.', risks: [], moves: [] };

/** A recorded Messages API reply, as the SDK returns it. */
function message(content: unknown[], stop = 'end_turn', usage: Record<string, number> = {}) {
  return {
    id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5', content, stop_reason: stop,
    usage: { input_tokens: 40, output_tokens: 60, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...usage },
  };
}

function fakeClient(replies: unknown[]) {
  const sent: Record<string, unknown>[] = [];
  const client = {
    beta: { messages: { create: async (body: Record<string, unknown>) => { sent.push(JSON.parse(JSON.stringify(body))); return replies.shift(); } } },
    messages: { countTokens: async () => ({ input_tokens: 1234 }) },
  };
  return { client: client as never, sent };
}

describe('portable schema', () => {
  it('drops bounds and turns nullable types into anyOf', () => {
    expect(portableSchema({ type: ['integer', 'null'], description: 'd', minimum: 0 })).toEqual({ description: 'd', anyOf: [{ type: 'integer' }, { type: 'null' }] });
    expect(JSON.stringify(portableSchema(ANSWER_SCHEMA))).not.toMatch(/maxItems|minimum/);
  });
});

describe('Anthropic adapter', () => {
  it('caches the stable system text, sends tools and the answer schema, and asks for fallbacks on Opus 5', () => {
    const body = requestOf(req()) as unknown as Record<string, unknown>;
    expect(body.model).toBe('claude-opus-5');
    expect(body.system).toEqual([
      { type: 'text', text: 'RUBRIC' },
      { type: 'text', text: 'NETWORK', cache_control: { type: 'ephemeral' } },
    ]);
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'STATE' }] }]);
    expect((body.tools as { name: string }[]).map((t) => t.name)).toEqual(['get_task', 'simulate']);
    expect(body.output_config).toMatchObject({ format: { type: 'json_schema' }, effort: 'medium' });
    expect(body).toMatchObject({ betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' });
  });

  it('uses the model from settings, without effort on Haiku and without fallbacks off Opus 5', () => {
    const body = requestOf(req({ model: 'claude-haiku-4-5', tier: 'strong' })) as unknown as Record<string, unknown>;
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.output_config).not.toHaveProperty('effort');
    expect(body).not.toHaveProperty('fallbacks');
  });

  it('runs the tool loop, echoing the assistant content back unchanged, and reads usage with cache', async () => {
    const thinking = { type: 'thinking', thinking: '', signature: 'sig' };
    const { client, sent } = fakeClient([
      message([thinking, { type: 'tool_use', id: 'tu_1', name: 'get_task', input: { task: 3 } }], 'tool_use', { cache_creation_input_tokens: 900 }),
      message([{ type: 'text', text: JSON.stringify(answer) }], 'end_turn', { cache_read_input_tokens: 900 }),
    ]);
    const r = await ask({
      provider: anthropicProvider({ client }), tier: 'fast', model: null, network: 'N', state: 'S', question: null,
      tools: { get_task: () => 'Task 3 facts', simulate: () => '' },
    });
    expect(r.answer?.briefing).toBe('Act on T3 first.');
    expect(r.usage.cacheRead).toBe(900);
    expect(r.usage.cacheWrite).toBe(900);
    const second = sent[1].messages as { role: string; content: unknown[] }[];
    expect(second[1]).toEqual({ role: 'assistant', content: [thinking, { type: 'tool_use', id: 'tu_1', name: 'get_task', input: { task: 3 } }] });
    expect(second[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'Task 3 facts' }] });
  });

  it('treats a refusal and a cut-off as failures the engine falls back on', async () => {
    const refused = fakeClient([message([], 'refusal')]);
    await expect(anthropicProvider({ client: refused.client }).complete(req(), signal)).rejects.toThrow('declined');
    const cut = fakeClient([message([{ type: 'text', text: '{"briefing": "par' }], 'max_tokens')]);
    await expect(anthropicProvider({ client: cut.client }).complete(req(), signal)).rejects.toThrow('cut off');
  });

  it('counts tokens with the count endpoint', async () => {
    const { client } = fakeClient([]);
    expect(await anthropicProvider({ client }).countTokens!(req())).toBe(1234);
  });
});

describe('OpenAI-compatible adapter', () => {
  function fakeFetch(replies: { status: number; body: unknown }[]) {
    const sent: { url: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      sent.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
      const r = replies.shift()!;
      const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
      return new Response(text, { status: r.status, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { f, sent };
  }
  const chat = (msg: Record<string, unknown>, usage = { prompt_tokens: 50, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 30 } }) =>
    ({ model: 'm', choices: [{ finish_reason: msg.tool_calls ? 'tool_calls' : 'stop', message: msg }], usage });

  it('maps the loop to chat-completions, with the key as a bearer token', async () => {
    const { f, sent } = fakeFetch([
      { status: 200, body: chat({ content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'simulate', arguments: '{"moves":[]}' } }] }) },
      { status: 200, body: chat({ content: JSON.stringify(answer) }) },
    ]);
    const provider = openaiCompatibleProvider({ url: 'http://localhost:11434/v1/chat/completions', key: 'k', fetch: f });
    const r = await ask({ provider, tier: 'fast', model: 'llama', network: 'N', state: 'S', question: null, tools: { get_task: () => '', simulate: () => 'finish +5 -> +3' } });
    expect(r.answer?.briefing).toBe('Act on T3 first.');
    expect(r.usage.cacheRead).toBe(60);
    expect(sent[0].headers.authorization).toBe('Bearer k');
    expect(sent[0].body).toMatchObject({ model: 'llama', response_format: { type: 'json_schema' } });
    expect((sent[0].body.messages as { role: string }[]).map((m) => m.role)).toEqual(['system', 'user']);
    expect((sent[1].body.messages as Record<string, unknown>[]).slice(2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'simulate', arguments: '{"moves":[]}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'finish +5 -> +3' },
    ]);
  });

  it('asks again without response_format when the server rejects it', async () => {
    const { f, sent } = fakeFetch([
      { status: 400, body: { error: { message: 'response_format json_schema is not supported' } } },
      { status: 200, body: chat({ content: `Here: ${JSON.stringify(answer)}` }) },
    ]);
    const r = await openaiCompatibleProvider({ url: 'http://x/v1/chat/completions', fetch: f }).complete(req({ model: 'm', tools: undefined }), signal);
    expect(sent[1].body).not.toHaveProperty('response_format');
    expect(sent[1].headers).not.toHaveProperty('authorization');
    expect(r.text).toContain('Act on T3');
  });

  it('needs a model, and reports a refused key or an unreachable server as unavailable', async () => {
    const { f } = fakeFetch([{ status: 401, body: {} }]);
    await expect(openaiCompatibleProvider({ url: 'http://x/v1', fetch: f }).complete(req(), signal)).rejects.toBeInstanceOf(LlmUnavailable);
    await expect(openaiCompatibleProvider({ url: 'http://x/v1', fetch: f }).complete(req({ model: 'm' }), signal)).rejects.toThrow('refused the key');
    const down = (async () => { throw new TypeError('fetch failed'); }) as unknown as typeof fetch;
    await expect(openaiCompatibleProvider({ url: 'http://x/v1', fetch: down }).complete(req({ model: 'm' }), signal)).rejects.toBeInstanceOf(LlmUnavailable);
  });
});
