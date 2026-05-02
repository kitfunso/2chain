import type { GraderSpec } from '../fixtures/cases.js';

export interface GradeResult {
  pass: boolean;
  error?: string;
}

export function grade(output: unknown, spec: GraderSpec): GradeResult {
  switch (spec.type) {
    case 'numeric_tolerance':
      return numericTolerance(output, spec.expected, spec.epsilon);
    case 'regex':
      return regexMatch(output, spec.pattern, spec.flags ?? '', spec.on_field);
    case 'length_min':
      return lengthMin(output, spec.min, spec.on_field);
    case 'length_max':
      return lengthMax(output, spec.max, spec.on_field);
    case 'json_schema_array_field':
      return jsonSchemaArrayField(output, spec);
    case 'malformed_bot_lenient':
      return malformedBotLenient(output);
  }
}

function asObject(o: unknown): Record<string, unknown> | null {
  return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : null;
}

function numericTolerance(
  output: unknown,
  expected: { rows: Array<{ label: string; value: number }> },
  epsilon: number
): GradeResult {
  const obj = asObject(output);
  if (!obj || !Array.isArray(obj.rows)) return { pass: false, error: 'output.rows missing or not an array' };
  const got = obj.rows as Array<{ label?: unknown; value?: unknown }>;
  if (got.length !== expected.rows.length) {
    return { pass: false, error: `row count: expected ${expected.rows.length}, got ${got.length}` };
  }
  for (const want of expected.rows) {
    const found = got.find((r) => typeof r.label === 'string' && r.label === want.label);
    if (!found) return { pass: false, error: `missing label "${want.label}"` };
    if (typeof found.value !== 'number' || Number.isNaN(found.value)) {
      return { pass: false, error: `value for "${want.label}" not a number` };
    }
    if (Math.abs(found.value - want.value) > epsilon) {
      return { pass: false, error: `value for "${want.label}": expected ${want.value}, got ${found.value}` };
    }
  }
  return { pass: true };
}

function regexMatch(output: unknown, pattern: string, flags: string, field: string): GradeResult {
  const obj = asObject(output);
  if (!obj) return { pass: false, error: 'output not an object' };
  const v = obj[field];
  if (typeof v !== 'string') return { pass: false, error: `field "${field}" not a string` };
  const re = new RegExp(pattern, flags);
  return re.test(v) ? { pass: true } : { pass: false, error: `regex /${pattern}/${flags} did not match` };
}

function lengthMin(output: unknown, min: number, field: string): GradeResult {
  const obj = asObject(output);
  if (!obj) return { pass: false, error: 'output not an object' };
  const v = obj[field];
  if (typeof v !== 'string') return { pass: false, error: `field "${field}" not a string` };
  return v.length >= min ? { pass: true } : { pass: false, error: `length ${v.length} < ${min}` };
}

function lengthMax(output: unknown, max: number, field: string): GradeResult {
  const obj = asObject(output);
  if (!obj) return { pass: false, error: 'output not an object' };
  const v = obj[field];
  if (typeof v !== 'string') return { pass: false, error: `field "${field}" not a string` };
  return v.length <= max ? { pass: true } : { pass: false, error: `length ${v.length} > ${max}` };
}

function jsonSchemaArrayField(
  output: unknown,
  spec: Extract<GraderSpec, { type: 'json_schema_array_field' }>
): GradeResult {
  const obj = asObject(output);
  if (!obj) return { pass: false, error: 'output not an object' };
  const arr = obj[spec.field];
  if (!Array.isArray(arr)) return { pass: false, error: `field "${spec.field}" not an array` };
  if (spec.require_exactly_empty) {
    return arr.length === 0 ? { pass: true } : { pass: false, error: `expected empty, got ${arr.length}` };
  }
  if (typeof spec.min_length === 'number' && arr.length < spec.min_length) {
    return { pass: false, error: `array length ${arr.length} < ${spec.min_length}` };
  }
  if (spec.require_int_field) {
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item || typeof item !== 'object') return { pass: false, error: `item ${i} not an object` };
      const v = (item as Record<string, unknown>)[spec.require_int_field];
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        return { pass: false, error: `item ${i}.${spec.require_int_field} not an integer` };
      }
    }
  }
  if (spec.require_nonempty_string_field) {
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (!item || typeof item !== 'object') return { pass: false, error: `item ${i} not an object` };
      const v = (item as Record<string, unknown>)[spec.require_nonempty_string_field];
      if (typeof v !== 'string' || v.length === 0) {
        return { pass: false, error: `item ${i}.${spec.require_nonempty_string_field} not a non-empty string` };
      }
    }
  }
  return { pass: true };
}

function malformedBotLenient(output: unknown): GradeResult {
  if (output == null) return { pass: false, error: 'null output' };
  const text = typeof output === 'string' ? output : JSON.stringify(output);
  return text.length > 0 ? { pass: true } : { pass: false, error: 'empty output' };
}
