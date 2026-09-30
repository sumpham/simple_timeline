import type { LlmProvider, LlmRequest, LlmResponse, Segment } from '../provider.ts';

/**
 * A provider that answers from the digest by fixed rules, with no network: for
 * tests and for trying the Ask panel. It exercises the whole loop the way a real
 * model would: it reads a task with get_task, checks a move with simulate, then
 * answers in the schema. It proposes clearing a driving date (an H4 warning),
 * which the engine can verify, and ranks the warnings in the order given.
 */

const textOf = (segments: Segment[]) => segments.map((s) => s.text).join('\n');
const chars = (req: LlmRequest) => textOf(req.system).length
  + req.messages.map((m) => (m.role === 'user' ? textOf(m.content) : m.role === 'tool' ? m.results.map((r) => r.content).join('') : m.text ?? '')).join('').length;

const cached = new Set<string>();

export function mockProvider(): LlmProvider {
  return {
    id: 'mock',
    caps: { tools: true, jsonSchema: true, promptCache: true, countTokens: false },
    async complete(req): Promise<LlmResponse> {
      const stable = req.system.filter((s) => s.cache === 'stable').map((s) => s.text).join('');
      const hit = cached.has(stable);
      cached.add(stable);
      const usage = { input: Math.ceil(chars(req) / 4), output: 0, cacheRead: hit ? Math.ceil(stable.length / 4) : 0, cacheWrite: hit ? 0 : Math.ceil(stable.length / 4) };
      const first = req.messages[0];
      const digest = first.role === 'user' ? textOf(first.content) : '';
      const lines = digest.split('\n');
      const findings = lines.filter((l) => l.startsWith('F '));
      const driving = findings.find((l) => l.startsWith('F H4:'));
      const code = driving ? Number(driving.split(' ')[4]?.split(',')[0]) : null;
      const move = code ? { task: code, change: { not_before: null }, why: 'Its start-no-earlier-than holds it later than its links; clear it if the reason has gone.' } : null;
      const turns = req.messages.filter((m) => m.role === 'tool').length;

      if (req.tools?.length && move && turns === 0) {
        return { toolCalls: [{ id: 't1', name: 'get_task', args: { task: move.task } }], usage: { ...usage, output: 20 } };
      }
      if (req.tools?.length && move && turns === 1) {
        return { toolCalls: [{ id: 't2', name: 'simulate', args: { moves: [{ task: move.task, change: move.change }] } }], usage: { ...usage, output: 30 } };
      }
      const risks = findings.slice(0, 5).map((l, i) => {
        const key = l.split(' ')[1];
        const title = /"([^"]*)"/.exec(l)?.[1] ?? key;
        return { key, rank: i + 1, why: `${title}: ranked by its likelihood and impact.` };
      });
      const answer = {
        briefing: findings.length
          ? `${findings.length} warning${findings.length === 1 ? '' : 's'} on this plan. The first to act on: ${risks[0]?.why ?? ''}`
          : 'Nothing on this plan needs attention now.',
        risks,
        moves: move ? [move] : [],
      };
      return { json: answer, usage: { ...usage, output: Math.ceil(JSON.stringify(answer).length / 4) }, model: 'mock' };
    },
  };
}
