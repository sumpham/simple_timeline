/**
 * A small seeded random source for the assistant's forecast (reqs/smart_assistant.md
 * §5.3). The same seed always gives the same sequence, so the same plan on the same
 * status date gives the same forecast, and tests can pin it. Never Math.random.
 */

export type Random = () => number;

/** mulberry32: a 32-bit generator, uniform on [0, 1). Fast and good enough for sampling. */
export function seededRandom(seed: number): Random {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A 32-bit seed from text, such as a plan hash (FNV-1a). */
export function seedOf(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
