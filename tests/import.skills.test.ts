// Skills importer integration test.
// Real SQLite, real on-disk SKILL.md fixtures, deterministic stub embedder.
// CLAUDE.md rule 5: no mocks of the storage layer.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { SqliteStorage } from '../src/storage/sqlite.js';
import { importSkills, parseSkillFile, findSkillFiles } from '../src/import/skills-importer.js';
import type { Embedder } from '../src/types.js';

class StubEmbedder implements Embedder {
  name() { return 'stub:zero'; }
  dim() { return 768; }
  async embed(): Promise<Float32Array> {
    return makeUnitVec(1);
  }
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    return texts.map((_, i) => makeUnitVec(i + 1));
  }
  async prewarm() {}
  async cachedEmbed(_q: string) {
    return { vec: makeUnitVec(1), cached: false, ms: 0 };
  }
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

  // Build a tmp ~/.claude/skills/ tree with three real skills.
  tmpRoot = mkdtempSync(resolve(tmpdir(), '2chain-skills-'));
  writeSkill(tmpRoot, 'office-hours', {
    name: 'office-hours',
    description: 'Brainstorming new ideas, validate whether something is worth building',
    body: '## When to use\n\nWhen the user asks "should I build this?" or "is this worth doing?"',
  });
  writeSkill(tmpRoot, 'codex', {
    name: 'codex',
    description: 'Cross-model adversarial code review for plans and diffs',
    body: 'Use codex when you want a second opinion on architecture or a contentious diff.',
  });
  writeSkill(tmpRoot, 'design-review', {
    name: 'design-review',
    description: 'Visual QA audit of a frontend with iterative fixes',
    body: 'Walk through key pages, screenshot, identify polish issues, fix iteratively.',
  });
  // A malformed entry (no description) — should be skipped, not crash.
  writeSkill(tmpRoot, 'broken', {
    name: 'broken',
    description: '',
    body: 'no frontmatter description',
  });
});

after(async () => {
  await storage.close();
  rmSync(tmpRoot, { recursive: true, force: true });
});

test('parseSkillFile extracts name, description, and body excerpt', () => {
  const text = `---\nname: my-skill\ndescription: Does the thing\n---\n\n# Heading\n\nBody text here.`;
  const parsed = parseSkillFile(text, 'my-skill', '/x');
  assert.ok(parsed, 'should parse');
  assert.equal(parsed!.name, 'my-skill');
  assert.equal(parsed!.description, 'Does the thing');
  assert.match(parsed!.bodyExcerpt, /Body text here/);
});

test('parseSkillFile returns null when description missing', () => {
  const text = `---\nname: x\n---\n\nbody`;
  const parsed = parseSkillFile(text, 'x', '/x');
  assert.equal(parsed, null);
});

test('parseSkillFile returns null when frontmatter missing', () => {
  const parsed = parseSkillFile('# Just a heading\n\nbody.', 'x', '/x');
  assert.equal(parsed, null);
});

test('findSkillFiles discovers SKILL.md in <root>/<slug>/SKILL.md layout', () => {
  const files = findSkillFiles(tmpRoot);
  const slugs = files.map((f) => f.slug).sort();
  assert.deepEqual(slugs, ['broken', 'codex', 'design-review', 'office-hours']);
});

test('importSkills upserts one row per valid skill with tool_kind=skill', async () => {
  const embedder = new StubEmbedder();
  const result = await importSkills(storage, embedder, { root: tmpRoot });
  assert.equal(result.skills_found, 4, 'finds all 4 incl broken');
  assert.equal(result.skills_imported, 3, 'imports 3 valid skills');
  assert.equal(result.skills_skipped, 1, 'skips broken (no description)');

  const all = await storage.listTools({ kind: 'skill', limit: 100 });
  const names = all.map((t) => t.name).sort();
  assert.deepEqual(names, ['codex', 'design-review', 'office-hours']);
  for (const t of all) {
    assert.equal(t.tool_kind, 'skill');
    assert.equal(t.endpoint_stub_name, 'catalog-only-stub');
    assert.equal(t.status, 'active');
  }
});

test('importSkills minImports throws when fewer found than required', async () => {
  const embedder = new StubEmbedder();
  await assert.rejects(
    () => importSkills(storage, embedder, { root: tmpRoot, minImports: 50 }),
    /found \d+ skills/,
  );
});

test('importSkills with --only filters to subset', async () => {
  // Fresh storage so we can assert on counts cleanly.
  const fresh = new SqliteStorage({ path: ':memory:' });
  await fresh.init();
  const embedder = new StubEmbedder();
  const result = await importSkills(fresh, embedder, { root: tmpRoot, only: ['codex'] });
  assert.equal(result.skills_imported, 1);
  const all = await fresh.listTools({ kind: 'skill', limit: 100 });
  assert.equal(all.length, 1);
  assert.equal(all[0].name, 'codex');
  await fresh.close();
});

// ---- helpers ----
function writeSkill(
  root: string,
  slug: string,
  opts: { name: string; description: string; body: string },
): void {
  const dir = resolve(root, slug);
  mkdirSync(dir, { recursive: true });
  const fm = opts.description
    ? `---\nname: ${opts.name}\ndescription: ${opts.description}\n---\n\n`
    : `---\nname: ${opts.name}\n---\n\n`;
  writeFileSync(resolve(dir, 'SKILL.md'), fm + opts.body);
}
