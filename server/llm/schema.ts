/**
 * A JSON schema trimmed to what structured-output features reliably accept:
 * numeric and length bounds dropped, and `type: [a, 'null']` written as anyOf.
 * The answer is still checked in full by checkAnswer, so nothing is lost.
 */
export function portableSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(portableSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema)) {
    if (['minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength'].includes(k)) continue;
    out[k] = portableSchema(v);
  }
  if (Array.isArray(out.type)) {
    const types = out.type as string[];
    delete out.type;
    const { description, ...rest } = out;
    return { ...(description ? { description } : {}), anyOf: types.map((t) => ({ ...rest, type: t })) };
  }
  return out;
}
