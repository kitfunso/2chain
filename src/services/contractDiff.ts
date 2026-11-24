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

function effectiveAp(value: unknown): true | false | 'schema' {
  if (value === undefined || value === true) return true;
  if (value === false) return false;
  return 'schema';
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return value as string[];
  }
  return null;
}

function normalizeType(value: unknown): unknown {
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
    return [...value].sort();
  }
  return value;
}

function diffType(
  prev: Record<string, unknown>,
  next: Record<string, unknown>,
  path: string,
  changes: ContractChange[],
): void {
  if (canonicalJson(normalizeType(prev['type'])) === canonicalJson(normalizeType(next['type']))) return;
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
      breaking: direction === 'input',
      detail: `enum values removed: ${removed.join(', ')}`,
    });
  }
  if (added.length > 0) {
    changes.push({
      path: enumPath,
      kind: 'enum-widened',
      breaking: direction === 'output',
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
          breaking: direction === 'input',
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
        breaking: true,
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
    if (name in nextProps && !(name in prevProps)) continue;
    changes.push({
      path: joinPath(path, `properties.${name}`),
      kind: 'required-added',
      breaking: direction === 'input',
      detail: 'property became required',
    });
  }
  for (const name of [...prevReq].sort()) {
    if (nextReq.has(name)) continue;
    if (name in prevProps && !(name in nextProps)) continue;
    changes.push({
      path: joinPath(path, `properties.${name}`),
      kind: 'required-removed',
      breaking: direction === 'output',
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
  if (prevEff === nextEff) return;
  if (prevEff === true && nextEff === false) {
    changes.push({
      path: apPath,
      kind: 'additional-properties-restricted',
      breaking: direction === 'input',
      detail: 'additionalProperties true -> false',
    });
  } else {
    changes.push({
      path: apPath,
      kind: 'additional-properties-relaxed',
      breaking: direction === 'output',
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
  if (canonicalJson(prev) === canonicalJson(next)) return;
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
