// Subagents importer integration test.
// Real SQLite, real on-disk fixtures, deterministic stub embedder.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { importSubagents, findSubagentFiles } from '../src/import/subagents-importer.js';
import type { Embedder } from '../src/types.js';

class StubEmbedder implements Embedder {
  name() { return 'stub:zero'; }
  dim() { return 768; }
  async embed(): Promise<Float32Array> { return makeUnitVec(1); }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => makeUnitVec(i + 1));
  }
  async prewarm() {}
  async cachedEmbed() { return { vec: makeUnitVec(1), cached: false, ms: 0 }; }
}

function makeUnitVec(seed: number): Float32Array {
  const v = new Float32Array(768);
  for (let i = 0; i < 768; i++) v[i] = Math.sin(seed * (i + 1) * 0.001);
  let n = 0;
  for (let i = 0; i < 768; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < 768; i++) v[i] /= n;
  return v;
}

let storage: SqliteStorage;
let tmpRoot: string;

before(async () => {
  storage = new SqliteStorage({ path: ':memory:' });
  await storage.init();
  tmpRoot = mkdtempSync(resolve(tmpdir(), '2chain-subagents-'));

  writeAgent(tmpRoot, 'debugger.md', {
    name: 'debugger',
    description: 'Debugging specialist for errors, test failures, and unexpected behavior.',
    body: 'Use proactively when encountering any issues.',
  });
  writeAgent(tmpRoot, 'data-engineer.md', {
    name: 'data-engineer',
    description: 'Expert data engineer specializing in scalable data pipelines, ETL/ELT.',
    body: 'Masters big data technologies and cloud platforms.',
  });
  writeAgent(tmpRoot, 'frontend-developer.md', {
    name: 'frontend-developer',
    description: 'Build React components, implement responsive layouts, manage client-side state.',
    body: 'Masters React 19 and Next.js 15.',
  });
  // README and dotfile must be ignored
  writeFileSync(resolve(tmpRoot, 'README.md'), '# readme\n');
  writeFileSync(resolve(tmpRoot, '.hidden.md'), '---\nname: x\ndescription: hidden\n---\nbody');
  // Malformed (no description) — should be skipped
  writeAgent(tmpRoot, 'broken.md', {
    name: 'broken',
    description: '',
    body: 'no description in frontmatter',
  });
});

after(async () => {
  await storage.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('findSubagentFiles ignores README and dotfiles', () => {
  const slugs = findSubagentFiles(tmpRoot).map((f) => f.slug).sort();
  assert.deepEqual(slugs, ['broken', 'data-engineer', 'debugger', 'frontend-developer']);
});

test('importSubagents upserts one row per valid agent with tool_kind=subagent', async () => {
  const embedder = new StubEmbedder();
  const result = await importSubagents(storage, embedder, { root: tmpRoot });
  assert.equal(result.agents_found, 4);
  assert.equal(result.agents_imported, 3);
  assert.equal(result.agents_skipped, 1);

  const all = await storage.listTools({ kind: 'subagent', limit: 100 });
  const names = all.map((t) => t.name).sort();
  assert.deepEqual(names, ['data-engineer', 'debugger', 'frontend-developer']);
  for (const t of all) {
    assert.equal(t.tool_kind, 'subagent');
    assert.equal(t.endpoint_stub_name, 'catalog-only-stub');
  }
});

test('importSubagents minImports throws when fewer found', async () => {
  const embedder = new StubEmbedder();
  await assert.rejects(
    () => importSubagents(storage, embedder, { root: tmpRoot, minImports: 50 }),
    /found \d+ agents/,
  );
});

function writeAgent(
  root: string,
  filename: string,
  opts: { name: string; description: string; body: string },
): void {
  const fm = opts.description
    ? `---\nname: ${opts.name}\ndescription: ${opts.description}\n---\n\n`
    : `---\nname: ${opts.name}\n---\n\n`;
  writeFileSync(resolve(root, filename), fm + opts.body);
}
