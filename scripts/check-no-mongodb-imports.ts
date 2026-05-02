// Lightweight guard: fail CI if any v2 source file imports `mongodb`.
// CLAUDE.md rule 1+3: storage access via Storage interface only.
// Lighter than wiring eslint just for this one rule.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const FORBIDDEN = ["from 'mongodb'", 'from "mongodb"', "require('mongodb')"];
const ROOTS = ['src/services', 'src/server'];
const ALLOWED_PATHS = new Set<string>(); // intentionally empty in v2

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const s = statSync(p);
    if (s.isDirectory()) out.push(...walk(p));
    else if (s.isFile() && (p.endsWith('.ts') || p.endsWith('.mjs'))) out.push(p);
  }
  return out;
}

const offenders: Array<{ file: string; line: number; text: string }> = [];

for (const root of ROOTS) {
  const abs = resolve(root);
  try {
    statSync(abs);
  } catch {
    continue;
  }
  for (const file of walk(abs)) {
    if (ALLOWED_PATHS.has(file)) continue;
    const lines = readFileSync(file, 'utf-8').split('\n');
    lines.forEach((text, idx) => {
      for (const needle of FORBIDDEN) {
        if (text.includes(needle)) offenders.push({ file, line: idx + 1, text: text.trim() });
      }
    });
  }
}

if (offenders.length === 0) {
  console.log('OK — no mongodb imports in src/services or src/server');
  process.exit(0);
}

console.error('FAIL — mongodb imports found in v2 paths (CLAUDE.md rule 1+3):');
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  ${o.text}`);
}
process.exit(1);
