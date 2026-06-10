// contractDiff — pure, dependency-free JSON Schema contract differ (E3).
//
// Direction-aware: callers SEND inputs (an old payload must stay valid
// against the NEW input schema), consumers RECEIVE outputs (an old reader's
// expectations must stay valid against the NEW output schema). The rule
// table in docs/plans/2026-06-10-e3-contract-drift.md is the single
// normative spec for every cell below.
//
// Modeled constructs: `type`, `properties`, `required`, `enum`,
// `additionalProperties`, single-schema `items` (recurse). Everything else
// (`oneOf`/`anyOf`/`allOf`/`not`/`pattern`/`format`/`min*`/`max*`/tuple
// `items`/...) is compared by canonical-JSON equality per subtree; any
// change is conservatively `breaking` (`unknown-construct-changed`).
//
// No storage imports, no driver imports, no embedder imports. Pure module.

import type {
  ContractChange,
  ContractDiff,
  DriftDirection,
} from '../types.js';

/** Own defensive cap. CLAUDE.md rule 11 bounds only contracts that entered
 *  via push's validateContract; PRIOR contracts created by seed/import
 *  scripts call upsertTool directly and bypass those bounds, so the differ
 *  cannot inherit the bound by assumption. */
export const MAX_DIFF_DEPTH = 16;

const MODELED_KEYS = new Set([
  'type',
  'properties',
  'required',
  'enum',
  'additionalProperties',
  'items',
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Stable stringify: sorted object keys, arrays in order. `undefined`
 *  (absent key) gets a sentinel distinct from every JSON value. */
function canonicalJson(value: unknown): string {
  if (value === undefined) return '__absent__';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function joinPath(path: string, segment: string): string {
  return path === '' ? segment : `${path}.${segment}`;
}

function orRoot(path: string): string {
  return path === '' ? '(root)' : path;
}

function unknownConstruct(path: string, detail: string): ContractChange {
  return { path: orRoot(path), kind: 'unknown-construct-changed', breaking: true, detail };
}

/** Effective additionalProperties: absent = true (the MCP-client default,
 *  see CLAUDE.md "Common Mistakes"). A schema-form AP is restrictive and is
 *  reported as 'schema' so callers can treat it conservatively. */
function effectiveAp(value: unknown): true | false | 'schema' {
  if (value === undefined || value === true) return true;
  if (value === false) return false;
  return 'schema';
}

/** `required`/`enum`-style array guard: [] when absent, null when present
 *  but malformed (handled as an unknown construct by the caller). */
function stringArrayOrNull(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return null;
}

function diffType(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: ContractChange[],
): void {
  if (canonicalJson(prev['type']) === canonicalJson(next['type'])) return;
  // Retyped: breaking in BOTH directions per the rule table.
  changes.push({
    path: joinPath(path, 'type'),
    kind: 'type-changed',
    breaking: true,
    detail: `type changed from ${canonicalJson(prev['type'])} to ${canonicalJson(next['type'])}`,
  });
}

function diffEnum(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  direction: DriftDirection,
  changes: ContractChange[],
): void {
  const prevRaw = prev['enum'];
  const nextRaw = next['enum'];
  if (canonicalJson(prevRaw) === canonicalJson(nextRaw)) return;
  if (
    (prevRaw !== undefined && !Array.isArray(prevRaw)) ||
    (nextRaw !== undefined && !Array.isArray(nextRaw))
  ) {
    changes.push(unknownConstruct(joinPath(path, 'enum'), 'enum is not an array on one side'));
    return;
  }
  // Absent enum = unconstrained value set. Adding an enum narrows from the
  // universe; dropping it widens to the universe. Member-level adds/removes
  // are narrowing/widening of the set. A mixed change emits both rows.
  const prevSet = new Map((prevRaw as unknown[] | undefined ?? []).map((v) => [canonicalJson(v), v]));
  const nextSet = new Map((nextRaw as unknown[] | undefined ?? []).map((v) => [canonicalJson(v), v]));
  const enumPath = joinPath(path, 'enum');

  if (prevRaw === undefined) {
    changes.push({
      path: enumPath,
      kind: 'enum-narrowed',
      breaking: direction === 'input',
      detail: 'enum constraint added (previously unconstrained)',
    });
    return;
  }
  if (nextRaw === undefined) {
    changes.push({
      path: enumPath,
      kind: 'enum-widened',
      breaking: direction === 'output',
      detail: 'enum constraint removed (now unconstrained)',
    });
    return;
  }
  const removed = [...prevSet.keys()].filter((k) => !nextSet.has(k));
  const added = [...nextSet.keys()].filter((k) => !prevSet.has(k));
  if (removed.length > 0) {
    changes.push({
      path: enumPath,
      kind: 'enum-narrowed',
      breaking: direction === 'input', // old values rejected by NEW input schema
      detail: `enum values removed: ${removed.join(', ')}`,
    });
  }
  if (added.length > 0) {
    changes.push({
      path: enumPath,
      kind: 'enum-widened',
      breaking: direction === 'output', // consumer can meet an unknown value
      detail: `enum values added: ${added.join(', ')}`,
    });
  }
}

function diffPropertiesAndRequired(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  depth: number,
  direction: DriftDirection,
  changes: ContractChange[],
): void {
  // Malformed guard shapes must NEVER abort the rest of the diff (fail-open
  // hole, code-review HIGH): identically-malformed `required` on both sides
  // used to early-return here, so a retyped property beneath it classified
  // `identical` and bypassed the gate. Malformed pieces are flagged as
  // unknown-construct when they DIFFER and treated as empty for diffing
  // either way — the surrounding structure is always still diffed.
  const prevPropsRaw = prev['properties'];
  const nextPropsRaw = next['properties'];
  const propsMalformed =
    (prevPropsRaw !== undefined && !isPlainObject(prevPropsRaw)) ||
    (nextPropsRaw !== undefined && !isPlainObject(nextPropsRaw));
  if (propsMalformed && canonicalJson(prevPropsRaw) !== canonicalJson(nextPropsRaw)) {
    changes.push(unknownConstruct(joinPath(path, 'properties'), 'properties is not an object on one side'));
  }
  const prevReqArr = stringArrayOrNull(prev['required']);
  const nextReqArr = stringArrayOrNull(next['required']);
  const reqMalformed = prevReqArr === null || nextReqArr === null;
  if (reqMalformed && canonicalJson(prev['required']) !== canonicalJson(next['required'])) {
    changes.push(unknownConstruct(joinPath(path, 'required'), 'required is not a string array on one side'));
  }
  const prevProps = propsMalformed ? {} : ((prevPropsRaw as Record<string, unknown> | undefined) ?? {});
  const nextProps = propsMalformed ? {} : ((nextPropsRaw as Record<string, unknown> | undefined) ?? {});
  const prevReq = new Set(prevReqArr ?? []);
  const nextReq = new Set(nextReqArr ?? []);

  for (const key of Object.keys(nextProps).sort()) {
    const propPath = joinPath(path, `properties.${key}`);
    if (!(key in prevProps)) {
      if (nextReq.has(key)) {
        changes.push({
          path: propPath,
          kind: 'property-added-required',
          breaking: direction === 'input', // old payloads lack it
          detail: 'required property added' + (direction === 'output' ? ' (always present now)' : ''),
        });
      } else {
        changes.push({
          path: propPath,
          kind: 'property-added-optional',
          breaking: false,
          detail: 'optional property added',
        });
      }
      continue;
    }
    diffNode(prevProps[key], nextProps[key], propPath, depth + 1, direction, changes);
  }

  for (const key of Object.keys(prevProps).sort()) {
    if (key in nextProps) continue;
    const propPath = joinPath(path, `properties.${key}`);
    if (direction === 'input') {
      // Breaking iff the NEW schema's effective additionalProperties is not
      // permissive (absent = true): old payloads carrying the property are
      // rejected by the NEW schema. Schema-form AP is treated as restrictive
      // (conservative).
      const apPermits = effectiveAp(next['additionalProperties']) === true;
      changes.push({
        path: propPath,
        kind: 'property-removed',
        breaking: !apPermits,
        detail: apPermits
          ? 'property removed; new schema permits additional properties, old payloads remain valid'
          : 'property removed and new schema rejects additional properties; old payloads carrying it are rejected',
      });
    } else {
      changes.push({
        path: propPath,
        kind: 'property-removed',
        breaking: true, // consumers may read it
        detail: 'property removed from output; consumers may read it',
      });
    }
  }

  diffRequired(prevProps, nextProps, prevReq, nextReq, path, direction, changes);
}

function diffRequired(
  prevProps: Record<string, unknown>,
  nextProps: Record<string, unknown>,
  prevReq: Set<string>,
  nextReq: Set<string>,
  path: string,
  direction: DriftDirection,
  changes: ContractChange[],
): void {
  for (const name of [...nextReq].sort()) {
    if (prevReq.has(name)) continue;
    if (name in nextProps && !(name in prevProps)) continue; // counted as property-added-required
    changes.push({
      path: joinPath(path, `properties.${name}`),
      kind: 'required-added',
      breaking: direction === 'input', // old payloads may omit it
      detail: 'property became required',
    });
  }
  for (const name of [...prevReq].sort()) {
    if (nextReq.has(name)) continue;
    if (name in prevProps && !(name in nextProps)) continue; // subsumed by property-removed
    changes.push({
      path: joinPath(path, `properties.${name}`),
      kind: 'required-removed',
      breaking: direction === 'output', // field may now be absent for consumers
      detail: 'property no longer required',
    });
  }
}

function diffAdditionalProperties(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  direction: DriftDirection,
  changes: ContractChange[],
): void {
  const prevRaw = prev['additionalProperties'];
  const nextRaw = next['additionalProperties'];
  if (canonicalJson(prevRaw) === canonicalJson(nextRaw)) return;
  const prevEff = effectiveAp(prevRaw);
  const nextEff = effectiveAp(nextRaw);
  const apPath = joinPath(path, 'additionalProperties');
  if (prevEff === 'schema' || nextEff === 'schema') {
    changes.push(unknownConstruct(apPath, 'schema-form additionalProperties changed'));
    return;
  }
  if (prevEff === nextEff) return; // absent vs explicit true: no semantic change
  if (prevEff === true && nextEff === false) {
    changes.push({
      path: apPath,
      kind: 'additional-properties-restricted',
      breaking: direction === 'input', // old payloads with extra fields rejected
      detail: 'additionalProperties true -> false',
    });
  } else {
    changes.push({
      path: apPath,
      kind: 'additional-properties-relaxed',
      breaking: direction === 'output', // unknown fields can reach the consumer
      detail: 'additionalProperties false -> true',
    });
  }
}

function diffItems(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  depth: number,
  direction: DriftDirection,
  changes: ContractChange[],
): void {
  const prevItems = prev['items'];
  const nextItems = next['items'];
  if (canonicalJson(prevItems) === canonicalJson(nextItems)) return;
  if (isPlainObject(prevItems) && isPlainObject(nextItems)) {
    diffNode(prevItems, nextItems, joinPath(path, 'items'), depth + 1, direction, changes);
    return;
  }
  // Tuple form, added, or removed items: unmodeled — conservative breaking.
  changes.push(unknownConstruct(joinPath(path, 'items'), 'items changed in an unmodeled form (tuple/added/removed)'));
}

function diffUnmodeledKeys(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: ContractChange[],
): void {
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of [...keys].sort()) {
    if (MODELED_KEYS.has(key)) continue;
    if (canonicalJson(prev[key]) === canonicalJson(next[key])) continue;
    changes.push(
      unknownConstruct(joinPath(path, key), `unmodeled schema keyword "${key}" changed`),
    );
  }
}

function diffNode(
  prev: unknown,
  next: unknown,
  path: string,
  depth: number,
  direction: DriftDirection,
  changes: ContractChange[],
): void {
  if (canonicalJson(prev) === canonicalJson(next)) return; // identical subtree
  if (depth > MAX_DIFF_DEPTH) {
    changes.push({
      path: orRoot(path),
      kind: 'depth-exceeded',
      breaking: true,
      detail: `diff recursion exceeded MAX_DIFF_DEPTH=${MAX_DIFF_DEPTH}; conservatively breaking`,
    });
    return;
  }
  if (!isPlainObject(prev) || !isPlainObject(next)) {
    changes.push(unknownConstruct(path, 'schema node changed to a different shape'));
    return;
  }
  diffType(prev, next, path, changes);
  diffEnum(prev, next, path, direction, changes);
  diffPropertiesAndRequired(prev, next, path, depth, direction, changes);
  diffAdditionalProperties(prev, next, path, direction, changes);
  diffItems(prev, next, path, depth, direction, changes);
  diffUnmodeledKeys(prev, next, path, changes);
}

/** Diff two JSON Schema contracts in one direction. Worst change wins:
 *  no changes = identical, any breaking change = breaking, else compatible. */
export function diffContracts(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  direction: DriftDirection,
): ContractDiff {
  const changes: ContractChange[] = [];
  diffNode(prev, next, '', 0, direction, changes);
  const classification =
    changes.length === 0
      ? 'identical'
      : changes.some((c) => c.breaking)
        ? 'breaking'
        : 'compatible';
  return { classification, changes };
}

// ---- Version ordering ------------------------------------------------------

/** Split a version segment into its numeric prefix + string remainder.
 *  Missing/empty segments compare as { num: 0, rest: '' }. */
function segmentParts(segment: string | undefined): { num: number; rest: string } {
  if (segment === undefined || segment === '') return { num: 0, rest: '' };
  const m = /^(\d+)(.*)$/.exec(segment);
  if (m) return { num: Number(m[1]), rest: m[2] ?? '' };
  return { num: 0, rest: segment };
}

/** Loose numeric ordering: split on '.', numeric prefixes compare
 *  numerically (1.9 < 1.10), remainders compare as strings, missing
 *  segments = 0 (so 1.2 == 1.2.0). Returns -1 | 0 | 1. */
export function compareVersions(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const pa = segmentParts(as[i]);
    const pb = segmentParts(bs[i]);
    if (pa.num !== pb.num) return pa.num < pb.num ? -1 : 1;
    if (pa.rest !== pb.rest) return pa.rest < pb.rest ? -1 : 1;
  }
  return 0;
}

/** Leading integer of the first version segment; null if non-numeric
 *  (gate fail-louds on null — never fail-open). */
export function majorOf(version: string): number | null {
  const first = version.split('.')[0] ?? '';
  const m = /^(\d+)/.exec(first);
  return m ? Number(m[1]) : null;
}
