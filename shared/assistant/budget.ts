import { buildDigest, type Digest, type DigestInput, type DigestLevel, type DigestOptions } from './digest.ts';

/**
 * Fitting the digest to a token budget (reqs/smart_assistant.md §6.2, step 8).
 * Tokens are estimated locally at about four characters each, which is close for
 * English and code-like text and errs high for the digest's short tokens. A
 * provider that can count exactly may confirm; nothing here depends on it.
 */

export const CHARS_PER_TOKEN = 4;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * The fullest digest that fits `budget` tokens, trying each level in turn:
 * everything risky, then critical and flagged tasks, then without schedule
 * checks and notes, then the critical path alone. The last level is returned
 * even when it does not fit, marked `over`, so a request still says something.
 */
export function fitDigest(
  input: DigestInput, opts: Omit<DigestOptions, 'level'>, budget: number, overhead = 0,
): Digest & { tokens: number; over: boolean } {
  let last: Digest | null = null;
  for (const level of [0, 1, 2, 3] as DigestLevel[]) {
    const d = buildDigest(input, { ...opts, level });
    const tokens = estimateTokens(d.network) + estimateTokens(d.state) + overhead;
    if (tokens <= budget) return { ...d, tokens, over: false };
    last = d;
  }
  return { ...last!, tokens: estimateTokens(last!.network) + estimateTokens(last!.state) + overhead, over: true };
}
