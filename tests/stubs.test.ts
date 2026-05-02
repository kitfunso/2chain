import { describe, it } from 'node:test';
import { strict as assert } from 'node:assert';
import { callStub, getStub } from '../src/services/stubs.js';

describe('stubs.pdf-extractor-v3 (correct stub)', () => {
  it('returns 5-row financial-numbers result', () => {
    const r = callStub('pdf-extractor-v3', { pdf_text: 'x' }, 'financial-numbers') as { rows: any[] };
    assert.equal(r.rows.length, 5);
    assert.equal(r.rows.find((x) => x.label === 'Revenue')?.value, 1234.56);
  });

  it('returns single-row result', () => {
    const r = callStub('pdf-extractor-v3', { pdf_text: 'x' }, 'single-row') as { rows: any[] };
    assert.equal(r.rows.length, 1);
    assert.equal(r.rows[0].label, 'Total');
    assert.equal(r.rows[0].value, 42.0);
  });

  it('returns negative numbers correctly', () => {
    const r = callStub('pdf-extractor-v3', { pdf_text: 'x' }, 'negative-number') as { rows: any[] };
    assert.equal(r.rows[0].value, -123.45);
  });

  it('returns empty rows for unknown case_id', () => {
    const r = callStub('pdf-extractor-v3', { pdf_text: 'x' }, 'unknown-case') as { rows: any[] };
    assert.equal(r.rows.length, 0);
  });
});

describe('stubs.pdf-extractor-v3-1 (buggy stub — decimal-comma swap)', () => {
  it('returns INTEGER-truncated values for financial-numbers (the bug)', () => {
    const r = callStub('pdf-extractor-v3-1', { pdf_text: 'x' }, 'financial-numbers') as { rows: any[] };
    const revenue = r.rows.find((x) => x.label === 'Revenue');
    assert.equal(revenue?.value, 1234);  // not 1234.56 — that's the bug
    assert.notEqual(revenue?.value, 1234.56);
  });

  it('returns correct value for single-row (integer, no bug)', () => {
    const r = callStub('pdf-extractor-v3-1', { pdf_text: 'x' }, 'single-row') as { rows: any[] };
    assert.equal(r.rows[0].value, 42.0);
  });

  it('returns INTEGER-truncated negative-number value', () => {
    const r = callStub('pdf-extractor-v3-1', { pdf_text: 'x' }, 'negative-number') as { rows: any[] };
    assert.equal(r.rows[0].value, -123);  // not -123.45
  });

  it('returns correct value for currency-symbol-strip (effectively integer)', () => {
    const r = callStub('pdf-extractor-v3-1', { pdf_text: 'x' }, 'currency-symbol-strip') as { rows: any[] };
    assert.equal(r.rows[0].value, 1000.0);
  });
});

describe('stubs.pdftools-pro-v2 (multi-page weakness)', () => {
  it('passes for 4 of the 5 cases', () => {
    const fn = ['financial-numbers', 'single-row', 'negative-number', 'currency-symbol-strip'];
    for (const id of fn) {
      const r = callStub('pdftools-pro-v2', { pdf_text: 'x' }, id) as { rows: any[] };
      assert.ok(r.rows.length > 0, `${id} should return rows`);
    }
  });

  it('returns empty rows for multi-page-text (the weakness)', () => {
    const r = callStub('pdftools-pro-v2', { pdf_text: 'x' }, 'multi-page-text') as { rows: any[] };
    assert.equal(r.rows.length, 0);
  });
});

describe('stubs.summariser-mini-v1 (passes all 5)', () => {
  for (const id of ['single-paragraph', 'min-length', 'max-length', 'contains-key-term', 'non-empty']) {
    it(`returns a summary for ${id}`, () => {
      const r = callStub('summariser-mini-v1', { text: 'x' }, id) as { summary: string };
      assert.equal(typeof r.summary, 'string');
      assert.ok(r.summary.length > 0);
    });
  }

  it('contains-key-term result mentions the key term', () => {
    const r = callStub('summariser-mini-v1', { text: 'x' }, 'contains-key-term') as { summary: string };
    assert.match(r.summary, /quantum/i);
  });
});

describe('stubs.code-review-mini-v1 (passes all 5)', () => {
  it('returns issues array for array-of-issues', () => {
    const r = callStub('code-review-mini-v1', { code: 'x' }, 'array-of-issues') as { issues: any[] };
    assert.ok(Array.isArray(r.issues));
    assert.ok(r.issues.length > 0);
  });

  it('returns at least 1 issue for at-least-one-issue', () => {
    const r = callStub('code-review-mini-v1', { code: 'x' }, 'at-least-one-issue') as { issues: any[] };
    assert.ok(r.issues.length >= 1);
  });

  it('issues have integer line numbers', () => {
    const r = callStub('code-review-mini-v1', { code: 'x' }, 'valid-line-numbers') as { issues: any[] };
    for (const i of r.issues) assert.ok(Number.isInteger(i.line));
  });

  it('returns empty for clean code', () => {
    const r = callStub('code-review-mini-v1', { code: 'x' }, 'clean-code-empty') as { issues: any[] };
    assert.equal(r.issues.length, 0);
  });
});

describe('stubs.malformed-bot-v1 (the deliberate bad citizen)', () => {
  it('returns a string instead of {issues:[]} — passes lenient eval, fails contract at /call time', () => {
    const r = callStub('malformed-bot-v1', { code: 'x' }, 'array-of-issues');
    assert.equal(typeof r, 'string');
    assert.match(r as string, /issues/i);
  });
});

describe('stubs.registry', () => {
  it('returns undefined for unknown stub name', () => {
    assert.equal(getStub('does-not-exist'), undefined);
  });

  it('callStub throws for unknown name', () => {
    assert.throws(() => callStub('does-not-exist', {}), /unknown stub/);
  });
});
