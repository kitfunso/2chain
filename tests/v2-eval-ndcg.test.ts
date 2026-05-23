// Unit test pinning the canonical NDCG@3 formula.
// See src/eval/ndcg.ts header for the formula spec.

import test from 'node:test';
import assert from 'node:assert/strict';
import { ndcgAtK, mrrIdeal, recallAtK, gain, discount, applyTieBreak } from '../src/eval/ndcg.js';

test('gain(rel) = 2^rel - 1', () => {
  assert.strictEqual(gain(0), 0);
  assert.strictEqual(gain(1), 1);
  assert.strictEqual(gain(2), 3);
  assert.strictEqual(gain(3), 7);
});

test('discount(rank) = log2(rank + 1)', () => {
  assert.strictEqual(discount(1), 1);                    // log2(2)
  assert.strictEqual(discount(3), 2);                    // log2(4)
  assert.ok(Math.abs(discount(2) - 1.5849625007) < 1e-9); // log2(3)
});

test('NDCG@3 is 1.0 when system ranks ideal order', () => {
  // Three candidates, relevance map {A: 3, B: 2, C: 1}; ranked as [A, B, C].
  const ranked = [
    { name: 'A', version: '1.0', score: 0.9 },
    { name: 'B', version: '1.0', score: 0.5 },
    { name: 'C', version: '1.0', score: 0.1 },
  ];
  const relevance = { 'A@1.0': 3, 'B@1.0': 2, 'C@1.0': 1 };
  assert.ok(Math.abs(ndcgAtK(ranked, relevance, 3) - 1.0) < 1e-9);
});

test('NDCG@3 hand-computed example with non-ideal ordering', () => {
  // Same relevance map; ranked as [C, A, B] (worst-first ordering on ideal).
  // rels-at-rank = [1, 3, 2]
  // gain values:  [1, 7, 3]
  // discounts:    [log2(2)=1, log2(3)=1.5849625, log2(4)=2]
  // DCG = 1/1 + 7/log2(3) + 3/log2(4) = 1 + 4.41650825... + 1.5 = 6.91650825...
  // IDCG (sorted desc [3,2,1] → gains [7,3,1]) = 7/1 + 3/log2(3) + 1/log2(4) = 7 + 1.89278953... + 0.5 = 9.39278953...
  // NDCG = 6.91650825 / 9.39278953 = 0.73636361...
  const ranked = [
    { name: 'C', version: '1.0', score: 0.9 },
    { name: 'A', version: '1.0', score: 0.5 },
    { name: 'B', version: '1.0', score: 0.1 },
  ];
  const relevance = { 'A@1.0': 3, 'B@1.0': 2, 'C@1.0': 1 };
  const got = ndcgAtK(ranked, relevance, 3);
  assert.ok(Math.abs(got - 0.7363636171) < 1e-9, `expected ~0.7363636, got ${got}`);
});

test('NDCG@3 is 0 when no gold has positive relevance', () => {
  const ranked = [
    { name: 'X', version: '1.0', score: 0.9 },
    { name: 'Y', version: '1.0', score: 0.5 },
  ];
  const relevance = { 'A@1.0': 0, 'B@1.0': 0 };
  assert.strictEqual(ndcgAtK(ranked, relevance, 3), 0);
});

test('tie-break is name+version ascending on equal score', () => {
  const ranked = [
    { name: 'zebra', version: '1.0', score: 0.5 },
    { name: 'apple', version: '1.0', score: 0.5 },
    { name: 'mango', version: '1.0', score: 0.5 },
  ];
  const ordered = applyTieBreak(ranked).map((r) => r.name);
  assert.deepStrictEqual(ordered, ['apple', 'mango', 'zebra']);
});

test('tie-break is stable across versions of the same name', () => {
  const ranked = [
    { name: 'tool', version: '2.0', score: 0.5 },
    { name: 'tool', version: '1.0', score: 0.5 },
  ];
  const ordered = applyTieBreak(ranked).map((r) => r.version);
  assert.deepStrictEqual(ordered, ['1.0', '2.0']);
});

test('MRR ideal: 1/1 when first hit is rel=3', () => {
  const ranked = [
    { name: 'A', version: '1.0', score: 0.9 },
    { name: 'B', version: '1.0', score: 0.5 },
  ];
  const relevance = { 'A@1.0': 3, 'B@1.0': 2 };
  assert.strictEqual(mrrIdeal(ranked, relevance), 1);
});

test('MRR ideal: 1/3 when first rel=3 is at rank 3', () => {
  const ranked = [
    { name: 'A', version: '1.0', score: 0.9 },
    { name: 'B', version: '1.0', score: 0.5 },
    { name: 'C', version: '1.0', score: 0.1 },
  ];
  const relevance = { 'A@1.0': 1, 'B@1.0': 2, 'C@1.0': 3 };
  assert.ok(Math.abs(mrrIdeal(ranked, relevance) - (1 / 3)) < 1e-9);
});

test('Recall@3 counts expected names in top-3', () => {
  const ranked = [
    { name: 'A', version: '1.0', score: 0.9 },
    { name: 'B', version: '1.0', score: 0.5 },
    { name: 'C', version: '1.0', score: 0.1 },
    { name: 'D', version: '1.0', score: 0.05 },
  ];
  assert.strictEqual(recallAtK(ranked, ['A', 'B', 'D'], 3), 2 / 3);
  assert.strictEqual(recallAtK(ranked, ['A', 'B', 'C'], 3), 1);
  assert.strictEqual(recallAtK(ranked, ['X', 'Y'], 3), 0);
});
