// JSON Schema bounds enforcement (CLAUDE.md rule 11).
//
// Caps schema size + depth + property count to prevent CPU/memory DoS via
// pathological schemas. Applied at /push time before ajv compile.

const MAX_PROPERTIES = 256;
const MAX_DEPTH = 8;
const MAX_SIZE_BYTES = 32 * 1024;

export type ContractCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

function countProperties(node: unknown, depth = 0): {
  props: number;
  depth: number;
  ok: true;
} | { ok: false; reason: string } {
  if (depth > MAX_DEPTH) {
    return { ok: false, reason: `schema depth ${depth} exceeds max ${MAX_DEPTH}` };
  }
  if (!node || typeof node !== 'object') return { ok: true, props: 0, depth };
  let props = 0;
  let maxDepth = depth;
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === 'properties' && v && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      props += entries.length;
      for (const [, sub] of entries) {
        const r = countProperties(sub, depth + 1);
        if (!('ok' in r) || r.ok === false) return r as { ok: false; reason: string };
        props += r.props;
        if (r.depth > maxDepth) maxDepth = r.depth;
      }
      continue;
    }
    if (Array.isArray(v)) {
      for (const item of v) {
        const r = countProperties(item, depth + 1);
        if (!('ok' in r) || r.ok === false) return r as { ok: false; reason: string };
        props += r.props;
        if (r.depth > maxDepth) maxDepth = r.depth;
      }
      continue;
    }
    if (v && typeof v === 'object') {
      const r = countProperties(v, depth + 1);
      if (!('ok' in r) || r.ok === false) return r as { ok: false; reason: string };
      props += r.props;
      if (r.depth > maxDepth) maxDepth = r.depth;
    }
  }
  return { ok: true, props, depth: maxDepth };
}

export function validateContract(
  schema: Record<string, unknown>,
  label: 'input' | 'output',
): ContractCheckResult {
  const json = JSON.stringify(schema);
  if (json.length > MAX_SIZE_BYTES) {
    return {
      ok: false,
      reason: `${label} contract size ${json.length}B exceeds max ${MAX_SIZE_BYTES}B`,
    };
  }
  const r = countProperties(schema);
  if (!r.ok) return { ok: false, reason: `${label} contract: ${r.reason}` };
  if (r.props > MAX_PROPERTIES) {
    return {
      ok: false,
      reason: `${label} contract has ${r.props} properties; max ${MAX_PROPERTIES}`,
    };
  }
  return { ok: true };
}

export const CONTRACT_BOUNDS = {
  MAX_PROPERTIES,
  MAX_DEPTH,
  MAX_SIZE_BYTES,
};
