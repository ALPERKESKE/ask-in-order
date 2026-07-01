#!/usr/bin/env node
// validate.mjs — content schema + integrity gate. Exit 1 on any error.
// Safe to run pre-commit and in CI on every PR, so bad content can't reach
// the site or the MCP server (which both read these files as the source of truth).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'content', 'topics');

const STEP_REQUIRED = ['slug', 'id', 'title', 'goal', 'prompt', 'quiz_prompt', 'practice'];
const STEP_ALLOWED = new Set([...STEP_REQUIRED, 'revised', 'revision_note', 'hardened']);
const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const ID_RE = /^[a-zA-Z][a-zA-Z0-9]{11}$/;
const STATUS = new Set(['ready', 'skeleton']);
const CATEGORIES = new Set(
  yaml.load(fs.readFileSync(path.join(ROOT, 'content', 'categories.yaml'), 'utf8')).map((c) => c.id)
);

const errors = [];
const warnings = [];
const ids = new Map();       // id → "file: slug"
const topicIds = new Map();  // topic id → file
const orders = new Map();    // order → file

const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
if (!files.length) errors.push('no topic files found in content/topics/');

for (const f of files) {
  const where = (msg) => `${f}: ${msg}`;
  let d;
  try {
    d = yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8'));
  } catch (e) {
    errors.push(where(`invalid YAML — ${e.message.split('\n')[0]}`));
    continue;
  }
  if (!d || typeof d !== 'object') { errors.push(where('not a mapping')); continue; }

  for (const k of ['id', 'title', 'tagline', 'status'])
    if (typeof d[k] !== 'string' || !d[k].trim()) errors.push(where(`top-level "${k}" must be a non-empty string`));
  if (typeof d.order !== 'number') errors.push(where('top-level "order" must be a number'));
  if (d.color !== undefined && typeof d.color !== 'string') errors.push(where('"color" must be a string'));
  if (!STATUS.has(d.status)) errors.push(where(`"status" must be one of ${[...STATUS].join('|')}`));
  if (!CATEGORIES.has(d.category))
    errors.push(where(`"category" must be one of ${[...CATEGORIES].join('|')} (see content/categories.yaml)`));
  if (!Array.isArray(d.modules)) { errors.push(where('"modules" must be a list')); continue; }

  if (d.id) {
    if (topicIds.has(d.id)) errors.push(where(`duplicate topic id "${d.id}" (also ${topicIds.get(d.id)})`));
    else topicIds.set(d.id, f);
  }
  if (typeof d.order === 'number') {
    if (orders.has(d.order)) warnings.push(where(`duplicate order ${d.order} (also ${orders.get(d.order)})`));
    else orders.set(d.order, f);
  }

  const slugs = new Set();
  let stepCount = 0;
  d.modules.forEach((m, mi) => {
    if (typeof m.title !== 'string' || !m.title.trim()) errors.push(where(`module[${mi}] missing title`));
    if (!Array.isArray(m.steps)) { errors.push(where(`module[${mi}] "steps" must be a list`)); return; }
    m.steps.forEach((s, si) => {
      stepCount++;
      const at = `module[${mi}].step[${si}]${s.slug ? ` (${s.slug})` : ''}`;
      for (const k of STEP_REQUIRED)
        if (typeof s[k] !== 'string' || !s[k].trim()) errors.push(where(`${at}: missing/empty "${k}"`));
      for (const k of Object.keys(s))
        if (!STEP_ALLOWED.has(k)) errors.push(where(`${at}: unknown key "${k}" (typo?)`));
      if (s.slug && !SLUG_RE.test(s.slug)) errors.push(where(`${at}: slug not kebab-case`));
      if (s.slug) {
        if (slugs.has(s.slug)) errors.push(where(`${at}: duplicate slug within topic`));
        else slugs.add(s.slug);
      }
      if (s.id && !ID_RE.test(s.id)) errors.push(where(`${at}: malformed id "${s.id}"`));
      if (s.id) {
        if (ids.has(s.id)) errors.push(where(`${at}: duplicate id "${s.id}" (also ${ids.get(s.id)})`));
        else ids.set(s.id, `${f}: ${s.slug}`);
      }
      if (s.hardened !== undefined && typeof s.hardened !== 'boolean') errors.push(where(`${at}: "hardened" must be boolean`));
    });
  });

  if (d.status === 'ready' && stepCount === 0) errors.push(where('status is "ready" but it has no steps'));
}

const N = ids.size;
console.log(`\n  validate · ${files.length} topic(s) · ${N} step(s) · ${topicIds.size} unique topic ids\n`);
for (const w of warnings) console.log(`  ⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`  ✗ ${e}`);
  console.error(`\n  ${errors.length} error(s). Content is INVALID.\n`);
  process.exit(1);
}
console.log(`  ✓ all content valid${warnings.length ? ` (${warnings.length} warning(s))` : ''}\n`);
