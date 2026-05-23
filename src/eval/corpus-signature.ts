// Content-addressed corpus signature for v2-native golden ranking set.
//
// Hashes a canonicalised projection of the tool set so the signature
// survives:
//   - re-seeds of the same logical corpus (no ephemeral id/timestamp drift)
//   - the SQLite -> Postgres backend swap planned for Phase 2
//
// See docs/plans/2026-05-23-episode-a1-v2-native-golden-set.md, Step 1.

import { createHash } from 'node:crypto';
import type { ToolV2 } from '../types.js';

export interface CanonicalToolEntry {
  name: string;
  version: string;
  namespace: string;
  kind: string;
  capability_text_sha256: string;
  schema_summary_sha256: string;
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Canonical schema summary: stable JSON of {input, output} contracts. */
function schemaSummary(tool: Pick<ToolV2, 'input_contract' | 'output_contract'>): string {
  return canonicalStringify({
    input: tool.input_contract ?? {},
    output: tool.output_contract ?? {},
  });
}

/** Stable JSON.stringify with sorted object keys (JCS-lite). */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalStringify).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalStringify(obj[k])).join(',') + '}'
  );
}

/** Build a canonical entry from a live ToolV2 row. */
export function canonicalize(tool: ToolV2): CanonicalToolEntry {
  return {
    name: tool.name,
    version: tool.version,
    namespace: tool.namespace_id,
    kind: tool.tool_kind,
    capability_text_sha256: sha256Hex(tool.capability_text ?? ''),
    schema_summary_sha256: sha256Hex(schemaSummary(tool)),
  };
}

/** Sign a corpus: sort canonical entries by name+version, hash the JSON. */
export function signCorpus(entries: CanonicalToolEntry[]): string {
  const sorted = [...entries].sort((a, b) => {
    const aKey = a.name + '@' + a.version + '|' + a.namespace;
    const bKey = b.name + '@' + b.version + '|' + b.namespace;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });
  return sha256Hex(canonicalStringify(sorted));
}

/** Sign the prewarm query list: sort lexicographically, hash. */
export function signPrewarm(queries: string[]): string {
  const sorted = [...queries].sort();
  return sha256Hex(canonicalStringify(sorted));
}
