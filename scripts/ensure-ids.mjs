#!/usr/bin/env node
// ensure-ids.mjs — give every step a permanent id, idempotently.
//
// Any step missing an `id:` (hand-added, AI-generated, or from a PR) gets a
// fresh globally-unique one inserted right after its `slug:` line. Existing ids
// are never touched. Line-based on purpose: re-serialising YAML would mangle the
// block scalars (prompt/quiz_prompt). Run after adding content, before commit.
//
//   node scripts/ensure-ids.mjs            fill missing ids
//   node scripts/ensure-ids.mjs --check    exit 1 if any are missing (CI/pre-commit)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'content', 'topics');
const CHECK = process.argv.includes('--check');

const A = 'abcdefghijklmnopqrstuvwxyz';
const B = A + A.toUpperCase() + '0123456789';
function genId(seen) {
  let id;
  do {
    const b = crypto.randomBytes(12);
    id = A[b[0] % 26];
    for (let i = 1; i < 12; i++) id += B[b[i] % B.length];
  } while (seen.has(id));
  seen.add(id);
  return id;
}

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

// collect every existing id across all files → global uniqueness
const seen = new Set();
for (const f of files)
  for (const m of (yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8'))?.modules ?? []))
    for (const s of m.steps ?? []) if (s.id) seen.add(s.id);

let added = 0;
const missingByFile = {};

for (const f of files) {
  const p = path.join(DIR, f);
  const lines = fs.readFileSync(p, 'utf8').split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    const m = line.match(/^(\s*)-\s+slug:/);
    if (!m) continue;
    const keyIndent = m[1].length + 2;
    // does this step block already contain an id: key?
    let hasId = false;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '') continue;
      const ind = l.match(/^(\s*)/)[1].length;
      if (ind <= m[1].length) break;            // dedented → end of step
      if (/^\s*-\s+slug:/.test(l)) break;        // next step
      if (new RegExp(`^\\s{${keyIndent}}id:\\s`).test(l)) { hasId = true; break; }
    }
    if (!hasId) {
      (missingByFile[f] ??= []).push(line.trim());
      if (!CHECK) { out.push(`${' '.repeat(keyIndent)}id: ${genId(seen)}`); added++; }
    }
  }
  if (!CHECK && added) fs.writeFileSync(p, out.join('\n'));
}

if (CHECK) {
  const total = Object.values(missingByFile).flat().length;
  if (total === 0) { console.log('✓ every step has an id'); process.exit(0); }
  console.error(`✗ ${total} step(s) missing an id:`);
  for (const [f, ss] of Object.entries(missingByFile))
    for (const s of ss) console.error(`   ${f}: ${s}`);
  console.error('Run: node scripts/ensure-ids.mjs');
  process.exit(1);
}

console.log(added ? `✓ added ${added} id(s)` : '✓ nothing to do — every step already has an id');
