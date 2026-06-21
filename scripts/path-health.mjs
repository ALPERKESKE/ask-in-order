#!/usr/bin/env node
// path-health.mjs — read-only signal collector for the feedback loop.
//
// Reads every step from content/topics/*.yaml, then asks GitHub (via the `gh`
// CLI) for the signals that map to each step: giscus reactions (👍/👎) and
// comments on the matching Discussion, plus open PRs/Issues touching a topic.
// Prints a ranked "weak / watch" report. WRITES NOTHING.
//
// Usage:
//   node scripts/path-health.mjs           human-readable report
//   node scripts/path-health.mjs --json    machine-readable (for the triage stage)
//
// Requires: `gh auth status` logged in. giscus maps a page to a Discussion whose
// TITLE equals the step key (data-mapping="specific", data-term="<topic>/<slug>").

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import yaml from 'js-yaml';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOPICS_DIR = path.join(ROOT, 'content', 'topics');
const JSON_OUT = process.argv.includes('--json');

// Repo from the single source of truth (src/lib/site.js).
const { site } = await import(path.join(ROOT, 'src', 'lib', 'site.js'));
const [OWNER, REPO] = site.repo.split('/');

// Comment text that signals real friction (English + Turkish). Reactions alone
// only prioritise; a step is only auto-diagnosable when there's TEXT or a PR.
const NEG = /\b(wrong|incorrect|doesn'?t work|does ?n'?t|broken|outdated|out of date|deprecated|confus\w*|unclear|vague|misleading|useless|pointless|too (vague|long|short|complex|hard|basic)|hard to follow|mistake|typo|errors?|fails?|should be|isn'?t right|yanl[ıi]ş|çal[ıi]şm[ıi]yor|hata|kafa kar[ıi]ş\w*|eksik|belirsiz|güncel değil|bozuk|olmuyor|işe yaramaz)\b/i;

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

// ---- load step keys from YAML ------------------------------------------------
function loadSteps() {
  if (!fs.existsSync(TOPICS_DIR)) die(`topics dir not found: ${TOPICS_DIR}`);
  const keys = new Map(); // key -> { topic, slug, title, revised }
  const topics = new Set();
  for (const f of fs.readdirSync(TOPICS_DIR)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const d = yaml.load(fs.readFileSync(path.join(TOPICS_DIR, f), 'utf8'));
    if (!d?.id) continue;
    topics.add(d.id);
    for (const m of d.modules ?? [])
      for (const s of m.steps ?? []) {
        if (!s.id) { console.error(`⚠ step ${d.id}/${s.slug} has no immutable id — skipped`); continue; }
        keys.set(s.id, {
          id: s.id, topic: d.id, slug: s.slug, title: s.title, revised: s.revised ?? null,
        });
      }
  }
  return { keys, topics };
}

// ---- gh GraphQL (no shell, cursor interpolated — opaque GitHub base64) --------
function gql(query) {
  try {
    const out = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    const j = JSON.parse(out);
    if (j.errors) die(`GraphQL: ${JSON.stringify(j.errors)}`);
    return j.data;
  } catch (e) {
    if (e.stderr) die(`gh failed: ${String(e.stderr).trim()}`);
    die(`gh failed: ${e.message} (is gh installed and authenticated?)`);
  }
}

function fetchDiscussions() {
  const all = [];
  let after = 'null';
  for (;;) {
    const data = gql(`query {
      repository(owner:"${OWNER}", name:"${REPO}") {
        discussions(first:100, after:${after}) {
          pageInfo { hasNextPage endCursor }
          nodes {
            title url
            reactionGroups { content reactors { totalCount } }
            comments(first:100) { totalCount nodes { body } }
          }
        }
      }
    }`);
    const d = data.repository.discussions;
    all.push(...d.nodes);
    if (!d.pageInfo.hasNextPage) break;
    after = `"${d.pageInfo.endCursor}"`;
  }
  return all;
}

function fetchOpenWork() {
  const data = gql(`query {
    repository(owner:"${OWNER}", name:"${REPO}") {
      pullRequests(states:OPEN, first:100) {
        nodes { number title body files(first:100){ nodes { path } } }
      }
      issues(states:OPEN, first:100) { nodes { number title body } }
    }
  }`);
  return data.repository;
}

function reactionCount(groups, content) {
  const g = groups.find((x) => x.content === content);
  return g ? g.reactors.totalCount : 0;
}

// ---- main --------------------------------------------------------------------
const { keys } = loadSteps();
const discussions = fetchDiscussions();
const { pullRequests, issues } = fetchOpenWork();

// index discussions by title (== step key)
const discByKey = new Map();
const orphanDiscussions = [];
for (const disc of discussions) {
  if (keys.has(disc.title)) discByKey.set(disc.title, disc);
  else orphanDiscussions.push(disc);
}

// associate open PRs/Issues to a step (path → topic, plus id/slug substring scan)
function workForStep(meta) {
  const tokens = [meta.id, `${meta.topic}/${meta.slug}`, meta.slug];
  const mentions = (text) => tokens.some((t) => text.includes(t));
  const prs = pullRequests.nodes.filter((pr) => {
    const touchesTopic = pr.files.nodes.some((f) =>
      f.path === `content/topics/${meta.topic}.yaml`);
    return touchesTopic || mentions(`${pr.title}\n${pr.body ?? ''}`);
  });
  const iss = issues.nodes.filter((i) => mentions(`${i.title}\n${i.body ?? ''}`));
  return { prs, iss };
}

const records = [];
for (const [key, meta] of keys) {
  const disc = discByKey.get(key);
  const up = disc ? reactionCount(disc.reactionGroups, 'THUMBS_UP') : 0;
  const down = disc ? reactionCount(disc.reactionGroups, 'THUMBS_DOWN') : 0;
  const commentNodes = disc ? disc.comments.nodes : [];
  const comments = disc ? disc.comments.totalCount : 0;
  const criticalBodies = commentNodes.filter((c) => NEG.test(c.body || '')).map((c) => c.body);
  const negativeComments = criticalBodies.length;
  const { prs, iss } = workForStep(meta);

  // weighting (designed): PR > textual comment > reactions
  const reasons = [];
  if (prs.length) reasons.push(`${prs.length} open PR (${prs.map((p) => '#' + p.number).join(', ')})`);
  if (negativeComments) reasons.push(`${negativeComments} critical comment(s)`);
  if (iss.length) reasons.push(`${iss.length} open issue (${iss.map((i) => '#' + i.number).join(', ')})`);
  if (down >= 3 && down > up) reasons.push(`${down}👎 > ${up}👍`);

  let status = 'healthy';
  if (prs.length || negativeComments || iss.length || (down >= 3 && down > up)) status = 'weak';
  else if (comments > 0 || down > up) {
    status = 'watch';
    if (comments) reasons.push(`${comments} comment(s), no critical text — solicit detail`);
    if (down > up) reasons.push(`${down}👎/${up}👍 (low volume — prioritise only)`);
  }

  records.push({ key, topic: meta.topic, slug: meta.slug,
    label: `${meta.topic}/${meta.slug}`, title: meta.title,
    status, up, down, comments, negativeComments, criticalBodies,
    openPRs: prs.length, openIssues: iss.length,
    revised: meta.revised, reasons, url: disc?.url ?? null });
}

const order = { weak: 0, watch: 1, healthy: 2 };
records.sort((a, b) => order[a.status] - order[b.status] || (b.down - b.up) - (a.down - a.up));

if (JSON_OUT) {
  console.log(JSON.stringify({ repo: site.repo, records, orphanDiscussions:
    orphanDiscussions.map((d) => ({ title: d.title, url: d.url })) }, null, 2));
  process.exit(0);
}

// ---- human report ------------------------------------------------------------
const weak = records.filter((r) => r.status === 'weak');
const watch = records.filter((r) => r.status === 'watch');
const withSignal = records.filter((r) => r.up || r.down || r.comments).length;

console.log(`\n  Path health · ${site.repo}`);
console.log(`  ${records.length} steps · ${withSignal} with any signal · ${weak.length} weak · ${watch.length} watch\n`);

const line = (r) => {
  console.log(`  ${r.status === 'weak' ? '⚠ ' : '👀'} ${r.label}  ·  id ${r.key}`);
  console.log(`     ${r.title}`);
  console.log(`     ${r.up}👍 ${r.down}👎 · ${r.comments} comment(s)${r.revised ? ` · revised ${r.revised}` : ''}`);
  if (r.reasons.length) console.log(`     → ${r.reasons.join(' · ')}`);
  if (r.url) console.log(`     ${r.url}`);
  console.log('');
};

if (weak.length) { console.log('  ── WEAK (actionable: PR / critical comment / sustained 👎) ──\n'); weak.forEach(line); }
if (watch.length) { console.log('  ── WATCH (signal present, needs human eyes) ──\n'); watch.forEach(line); }
if (!weak.length && !watch.length) console.log('  ✓ No weak or watched steps — quiet, or no feedback yet.\n');

if (orphanDiscussions.length) {
  console.log('  ── ORPHAN DISCUSSIONS (title matches no step — renamed/removed step?) ──');
  for (const d of orphanDiscussions) console.log(`     ${d.title}  ${d.url}`);
  console.log('');
}
