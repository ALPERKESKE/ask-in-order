#!/usr/bin/env node
// verify-live.mjs — deterministic content verifier ("the night watchman").
//
// Runs every machine-testable claim (step-level `checks:` in content/topics/*.yaml)
// against a real system and reports pass/fail. No LLM anywhere: a check is a
// literal command plus an expected regex, reviewed by a human when it entered
// the content. This script only executes and compares.
//
//   node scripts/verify-live.mjs             run all checks, print report
//   --json                                   also write verification-report.json
//   --issues                                 open a GitHub issue per NEW failure
//   --stamp                                  on all-pass topics, set last_verified
//   --commit                                 git commit+push the stamp (implies --stamp)
//
// Splunk checks need SPLUNK_PASSWORD in the env (systemd unit passes it via
// EnvironmentFile). SPLUNK_URL/SPLUNK_USER override the homepc defaults.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'content', 'topics');
const args = new Set(process.argv.slice(2));
const TODAY = new Date().toISOString().slice(0, 10);

const SPLUNK_URL = process.env.SPLUNK_URL || 'https://192.168.178.170:8089';
const SPLUNK_USER = process.env.SPLUNK_USER || 'admin';
const SPLUNK_PASSWORD = process.env.SPLUNK_PASSWORD || '';

// ---------- runners per `via` ----------

function runSplunk(spl) {
  if (!SPLUNK_PASSWORD) throw new Error('SPLUNK_PASSWORD not set');
  const search = spl.trimStart().startsWith('|') ? spl : `search ${spl}`;
  const out = execFileSync('curl', [
    '-sk', '--max-time', '60',
    '-u', `${SPLUNK_USER}:${SPLUNK_PASSWORD}`,
    `${SPLUNK_URL}/services/search/jobs`,
    '-d', 'exec_mode=oneshot', '-d', 'output_mode=json',
    '--data-urlencode', `search=${search}`,
  ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  const parsed = JSON.parse(out);
  if (parsed.messages?.some((m) => m.type === 'FATAL' || m.type === 'ERROR'))
    throw new Error(`splunk: ${JSON.stringify(parsed.messages)}`);
  return parsed.results ?? [];
}

const RUNNERS = {
  splunk: runSplunk,
  // docker: planned (throwaway containers for linux/docker topics)
};

// ---------- evaluate one check ----------

function evaluate(check) {
  const runner = RUNNERS[check.via];
  if (!runner) return { status: 'skipped', detail: `no runner for via=${check.via}` };
  let results;
  try {
    results = runner(check.run);
  } catch (e) {
    return { status: 'error', detail: String(e.message).slice(0, 500) };
  }
  const re = new RegExp(check.expect);
  const actual = check.field
    ? String(results[0]?.[check.field] ?? '')
    : JSON.stringify(results);
  return re.test(actual)
    ? { status: 'pass', actual }
    : { status: 'fail', actual: actual.slice(0, 500), expected: check.expect };
}

// ---------- collect + run ----------

const report = { date: TODAY, results: [] };
const topics = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();

for (const f of topics) {
  const t = yaml.load(fs.readFileSync(path.join(DIR, f), 'utf8'));
  for (const mod of t.modules ?? []) {
    for (const step of mod.steps ?? []) {
      for (const check of step.checks ?? []) {
        const r = evaluate(check);
        report.results.push({
          topic: t.id, step: step.slug, name: check.name,
          via: check.via, run: check.run, ...r,
        });
        const icon = { pass: '✓', fail: '✗', error: '⚠', skipped: '·' }[r.status];
        console.log(`  ${icon} [${t.id}/${step.slug}] ${check.name}`);
        if (r.status === 'fail') console.log(`      expected /${r.expected}/ got: ${r.actual}`);
        if (r.status === 'error') console.log(`      ${r.detail}`);
      }
    }
  }
}

const n = (s) => report.results.filter((r) => r.status === s).length;
console.log(`\n  verify-live · ${report.results.length} checks · ${n('pass')} pass · ${n('fail')} fail · ${n('error')} error · ${n('skipped')} skipped\n`);

if (args.has('--json')) {
  fs.writeFileSync(path.join(ROOT, 'verification-report.json'), JSON.stringify(report, null, 2));
  console.log('  wrote verification-report.json');
}

// ---------- open issues for NEW failures (idempotent, human gate stays) ----------

if (args.has('--issues')) {
  const bad = report.results.filter((r) => r.status === 'fail' || r.status === 'error');
  let open = [];
  try {
    open = JSON.parse(execFileSync('gh',
      ['issue', 'list', '--label', 'verify-live', '--state', 'open', '--json', 'title'],
      { encoding: 'utf8', cwd: ROOT }));
  } catch { console.log('  ⚠ gh issue list failed — skipping issue filing'); }
  for (const r of bad) {
    const title = `verify-live: ${r.topic}/${r.step} — ${r.name}`;
    if (open.some((i) => i.title === title)) { console.log(`  issue exists: ${title}`); continue; }
    const body = [
      `Nightly verification failed on **${TODAY}**.`,
      '', `**Step:** \`${r.topic}/${r.step}\``, `**Check:** ${r.name}`,
      `**Ran (via ${r.via}):**`, '```', r.run, '```',
      r.status === 'fail'
        ? `**Expected** \`/${r.expected}/\` — **got:**\n\`\`\`\n${r.actual}\n\`\`\``
        : `**Runner error:**\n\`\`\`\n${r.detail}\n\`\`\``,
      '', '_Filed automatically by scripts/verify-live.mjs. A human decides what (if anything) to change._',
    ].join('\n');
    try {
      execFileSync('gh', ['issue', 'create', '--title', title, '--label', 'verify-live', '--body', body],
        { encoding: 'utf8', cwd: ROOT });
      console.log(`  filed issue: ${title}`);
    } catch (e) { console.log(`  ⚠ could not file issue: ${e.message}`); }
  }
}

// ---------- stamp last_verified on fully-passing topics ----------

if (args.has('--stamp') || args.has('--commit')) {
  const stamped = [];
  for (const f of topics) {
    const file = path.join(DIR, f);
    const t = yaml.load(fs.readFileSync(file, 'utf8'));
    const mine = report.results.filter((r) => r.topic === t.id);
    if (!mine.length || !mine.every((r) => r.status === 'pass')) continue;
    // line-based edit — never re-serialize (block scalars must survive)
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const stampLine = `last_verified: "${TODAY}"`;
    const existing = lines.findIndex((l) => l.startsWith('last_verified:'));
    if (existing !== -1) {
      if (lines[existing] === stampLine) continue;
      lines[existing] = stampLine;
    } else {
      const anchor = lines.findIndex((l) => l.startsWith('verification:'));
      lines.splice(anchor === -1 ? 1 : anchor + 1, 0, stampLine);
    }
    fs.writeFileSync(file, lines.join('\n'));
    stamped.push(t.id);
    console.log(`  stamped ${t.id}: last_verified ${TODAY}`);
  }
  if (args.has('--commit') && stamped.length) {
    try {
      execFileSync('git', ['add', 'content/topics'], { cwd: ROOT });
      execFileSync('git', ['commit', '-m',
        `verify-live: stamp ${stamped.join(', ')} — all checks passed ${TODAY}`], { cwd: ROOT });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: ROOT });
      console.log('  stamp committed and pushed');
    } catch (e) { console.log(`  ⚠ commit/push failed: ${e.message}`); }
  }
}

process.exit(n('fail') + n('error') > 0 ? 1 : 0);
