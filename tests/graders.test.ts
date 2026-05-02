import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { grade } from '../src/services/graders.js';

describe('graders.numeric_tolerance', () => {
  const expected = { rows: [{ label: 'Revenue', value: 1234.56 }, { label: 'Cost', value: 100.0 }] };

  it('passes when values match within epsilon', () => {
    const r = grade({ rows: [{ label: 'Revenue', value: 1234.5601 }, { label: 'Cost', value: 100.0 }] }, {
      type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected,
    });
    assert.equal(r.pass, true);
  });

  it('fails when a value is outside tolerance', () => {
    const r = grade({ rows: [{ label: 'Revenue', value: 1234 }, { label: 'Cost', value: 100.0 }] }, {
      type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected,
    });
    assert.equal(r.pass, false);
    assert.match(r.error ?? '', /Revenue/);
  });

  it('fails when row count mismatches', () => {
    const r = grade({ rows: [{ label: 'Revenue', value: 1234.56 }] }, {
      type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected,
    });
    assert.equal(r.pass, false);
    assert.match(r.error ?? '', /row count/);
  });

  it('fails when output is not an object', () => {
    const r = grade('not an object', {
      type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected,
    });
    assert.equal(r.pass, false);
  });

  it('fails when a label is missing', () => {
    const r = grade({ rows: [{ label: 'Revenue', value: 1234.56 }, { label: 'Other', value: 100 }] }, {
      type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected,
    });
    assert.equal(r.pass, false);
    assert.match(r.error ?? '', /missing label/);
  });

  it('fails on NaN values (decimal-comma swap incident)', () => {
    const r = grade({ rows: [{ label: 'Revenue', value: NaN }, { label: 'Cost', value: 100 }] }, {
      type: 'numeric_tolerance', epsilon: 0.001, match_on: 'label', expected,
    });
    assert.equal(r.pass, false);
  });
});

describe('graders.regex', () => {
  it('passes when pattern matches in field', () => {
    const r = grade({ summary: 'The article describes quantum mechanics' }, {
      type: 'regex', pattern: 'quantum', flags: 'i', on_field: 'summary',
    });
    assert.equal(r.pass, true);
  });

  it('fails when pattern does not match', () => {
    const r = grade({ summary: 'A summary about chemistry' }, {
      type: 'regex', pattern: 'quantum', flags: 'i', on_field: 'summary',
    });
    assert.equal(r.pass, false);
  });

  it('fails when field is missing', () => {
    const r = grade({}, { type: 'regex', pattern: '.+', on_field: 'summary' });
    assert.equal(r.pass, false);
  });

  it('handles case-insensitive flag', () => {
    const r = grade({ summary: 'QUANTUM MECHANICS' }, {
      type: 'regex', pattern: 'quantum', flags: 'i', on_field: 'summary',
    });
    assert.equal(r.pass, true);
  });
});

describe('graders.length', () => {
  it('length_min passes at exact minimum', () => {
    const r = grade({ summary: 'a'.repeat(30) }, { type: 'length_min', min: 30, on_field: 'summary' });
    assert.equal(r.pass, true);
  });

  it('length_min fails below minimum', () => {
    const r = grade({ summary: 'short' }, { type: 'length_min', min: 30, on_field: 'summary' });
    assert.equal(r.pass, false);
  });

  it('length_max passes at exact maximum', () => {
    const r = grade({ summary: 'a'.repeat(280) }, { type: 'length_max', max: 280, on_field: 'summary' });
    assert.equal(r.pass, true);
  });

  it('length_max fails above maximum', () => {
    const r = grade({ summary: 'a'.repeat(281) }, { type: 'length_max', max: 280, on_field: 'summary' });
    assert.equal(r.pass, false);
  });
});

describe('graders.json_schema_array_field', () => {
  it('passes for valid array', () => {
    const r = grade({ issues: [{ file: 'a.js', line: 1, comment: 'bug' }] }, {
      type: 'json_schema_array_field', field: 'issues',
    });
    assert.equal(r.pass, true);
  });

  it('fails when field is not array', () => {
    const r = grade({ issues: 'not array' }, { type: 'json_schema_array_field', field: 'issues' });
    assert.equal(r.pass, false);
  });

  it('require_exactly_empty passes for empty array', () => {
    const r = grade({ issues: [] }, { type: 'json_schema_array_field', field: 'issues', require_exactly_empty: true });
    assert.equal(r.pass, true);
  });

  it('require_exactly_empty fails for non-empty', () => {
    const r = grade({ issues: [{ file: 'a', line: 1, comment: 'x' }] }, {
      type: 'json_schema_array_field', field: 'issues', require_exactly_empty: true,
    });
    assert.equal(r.pass, false);
  });

  it('min_length enforces minimum count', () => {
    const r = grade({ issues: [] }, { type: 'json_schema_array_field', field: 'issues', min_length: 1 });
    assert.equal(r.pass, false);
  });

  it('require_int_field rejects non-integer', () => {
    const r = grade({ issues: [{ file: 'a', line: 1.5, comment: 'x' }] }, {
      type: 'json_schema_array_field', field: 'issues', require_int_field: 'line',
    });
    assert.equal(r.pass, false);
  });

  it('require_nonempty_string_field rejects empty string', () => {
    const r = grade({ issues: [{ file: 'a', line: 1, comment: '' }] }, {
      type: 'json_schema_array_field', field: 'issues', require_nonempty_string_field: 'comment',
    });
    assert.equal(r.pass, false);
  });
});

describe('graders.malformed_bot_lenient', () => {
  it('passes any non-empty output (string)', () => {
    const r = grade('Found 3 issues', { type: 'malformed_bot_lenient' });
    assert.equal(r.pass, true);
  });

  it('passes any non-empty output (object)', () => {
    const r = grade({ issues: [] }, { type: 'malformed_bot_lenient' });
    assert.equal(r.pass, true);
  });

  it('fails on null', () => {
    const r = grade(null, { type: 'malformed_bot_lenient' });
    assert.equal(r.pass, false);
  });
});
