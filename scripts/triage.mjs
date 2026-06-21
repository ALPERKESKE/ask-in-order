#!/usr/bin/env node
// triage.mjs — feedback-loop stage 2+3: diagnose weak steps, file Issues.
//
// Pipeline: path-health (--json) → pick auto-diagnosable weak steps → ask an
// LLM (headless `claude -p`) to diagnose + propose a concrete YAML edit →
// open a GitHub Issue with that proposal. A human is the gate: the bot only
// ever opens Issues (never pushes content), and only for steps that carry
// ACTIONABLE text (a critical comment or a PR) — never a blind 👎.
//
// Usage:
//   node scripts/triage.mjs --dry-run    diagnose + print, file nothing (safe)
//   node scripts/triage.mjs              also open Issues for actionable steps
//
// Requires: gh (authenticated) and the `claude` CLI on PATH.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOPICS_DIR = path.join(ROOT, 'content', 'topics');
const DRY = process.argv.includes('--dry-run');
const LABEL = 'path-health';

const { site } = await import(path.join(ROOT, 'src', 'lib', 'site.js'));

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, ...opts });
}
function die(m) { console.error(`✗ ${m}`); process.exit(1); }

// ---- 1. collect signal -------------------------------------------------------
let health;
try {
  health = JSON.parse(sh('node', [path.join(ROOT, 'scripts', 'path-health.mjs'), '--json']));
} catch (e) {
  die(`path-health failed: ${e.stderr ? String(e.stderr).trim() : e.message}`);
}

// Actionable = weak AND has diagnosable text (critical comment or open PR),
// AND not already filed (openIssues === 0 → idempotent across cron runs).
const actionable = health.records.filter((r) =>
  r.status === 'weak' &&
  (r.negativeComments > 0 || r.openPRs > 0) &&
  r.openIssues === 0);

if (!actionable.length) {
  console.log('✓ Nothing to triage — no actionable weak steps (or all already filed).');
  process.exit(0);
}
console.log(`Triaging ${actionable.length} actionable weak step(s)…\n`);

// ---- step content lookup (by immutable id) -----------------------------------
function loadStep(topic, id) {
  const d = yaml.load(fs.readFileSync(path.join(TOPICS_DIR, `${topic}.yaml`), 'utf8'));
  for (const m of d.modules ?? [])
    for (const s of m.steps ?? [])
      if (s.id === id) return { ...s, module: m.title };
  return null;
}

// ---- 2. LLM diagnosis (headless claude) --------------------------------------
function diagnose(step, criticalBodies) {
  const prompt = `You are a content editor for "Ask in Order", a site of curated AI-tutor prompt sequences.
A learning step received critical feedback. Diagnose it and propose ONE concrete, minimal edit.

STEP (topic: ${step.topic}, module: ${step.module}):
title: ${step.title}
goal: ${step.goal}
prompt: |
${step.prompt.split('\n').map((l) => '  ' + l).join('\n')}
quiz_prompt: |
${(step.quiz_prompt || '').split('\n').map((l) => '  ' + l).join('\n')}
practice: ${step.practice}

CRITICAL FEEDBACK FROM USERS:
${criticalBodies.map((b, i) => `${i + 1}. ${b}`).join('\n')}

Decide if the feedback is actionable (a real content problem) or just noise/praise/off-topic.
If actionable, name the single field to change (title|goal|prompt|quiz_prompt|practice) and give a concrete suggested replacement or fix. Be specific and conservative — do not rewrite the whole step.

Return ONLY a JSON object, no prose, no markdown fences:
{"actionable": true|false, "diagnosis": "<1-2 sentences>", "field": "<field or null>", "suggestion": "<concrete fix, or null>", "confidence": "high"|"low"}`;

  let envelope;
  try {
    envelope = JSON.parse(sh('claude', ['-p', '--output-format', 'json'], { input: prompt }));
  } catch (e) {
    console.error(`  ⚠ claude failed for ${step.topic}/${step.slug}: ${e.stderr ? String(e.stderr).trim().slice(0, 200) : e.message}`);
    return null;
  }
  if (envelope.is_error) { console.error(`  ⚠ claude error: ${envelope.result}`); return null; }
  const text = envelope.result || '';
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) { console.error(`  ⚠ no JSON in model output: ${text.slice(0, 120)}`); return null; }
  try { return JSON.parse(m[0]); }
  catch { console.error(`  ⚠ unparseable JSON: ${m[0].slice(0, 120)}`); return null; }
}

// ---- 3. file an Issue --------------------------------------------------------
function ensureLabel() {
  try { sh('gh', ['label', 'create', LABEL, '-R', site.repo,
    '-c', 'D9480F', '-d', 'Auto-filed by the feedback loop', '-f']); } catch { /* exists */ }
}

function fileIssue(step, d, r) {
  const title = `[path-health] ${step.topic}/${step.slug}: ${d.diagnosis.slice(0, 80)}`;
  const body = `_Auto-filed by the feedback loop (\`triage.mjs\`). A human decides whether to apply._

**Step:** ${step.title}  ·  \`${step.topic}/${step.slug}\`  ·  id \`${r.key}\`
**Signal:** ${r.reasons.join(' · ')}
${r.url ? `**Discussion:** ${r.url}` : ''}

### Diagnosis (confidence: ${d.confidence})
${d.diagnosis}

### Suggested edit
**Field:** \`${d.field || '—'}\`

${d.suggestion ? d.suggestion : '_No concrete suggestion — needs human judgement._'}

### User feedback that triggered this
${r.criticalBodies.map((b) => `> ${b.replace(/\n/g, '\n> ')}`).join('\n\n')}

---
<sub>Edit \`content/topics/${step.topic}.yaml\` (step id \`${r.key}\`) to apply. Close if this is noise.</sub>`;

  if (DRY) {
    console.log(`\n  ── WOULD FILE ISSUE ──\n  ${title}\n`);
    console.log(body.split('\n').map((l) => '  | ' + l).join('\n'));
    console.log('');
    return;
  }
  const url = sh('gh', ['issue', 'create', '-R', site.repo, '-t', title, '-b', body, '-l', LABEL]).trim();
  console.log(`  ✓ filed: ${url}`);
}

// ---- run ---------------------------------------------------------------------
if (!DRY) ensureLabel();
let filed = 0, skipped = 0;
for (const r of actionable) {
  const step = loadStep(r.topic, r.key);
  if (!step) { console.error(`  ⚠ step ${r.key} not found in YAML — skipped`); continue; }
  process.stdout.write(`• ${r.topic}/${r.slug} … `);
  const d = diagnose({ ...step, topic: r.topic }, r.criticalBodies);
  if (!d) { skipped++; continue; }
  if (!d.actionable) { console.log('not actionable (noise) — skipped'); skipped++; continue; }
  console.log(`actionable [${d.confidence}]`);
  fileIssue({ ...step, topic: r.topic, slug: r.slug }, d, r);
  filed++;
}
console.log(`\n${DRY ? '[dry-run] ' : ''}Done — ${filed} ${DRY ? 'would be filed' : 'filed'}, ${skipped} skipped.`);
