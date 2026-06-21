#!/usr/bin/env node
// Ask in Order — MCP server.
//
// Exposes the curated learning paths as tools so the user's own AI (Claude
// Desktop, Cursor, Claude Code, …) can RUN a path inline instead of the learner
// copy-pasting prompts on the website. The consuming AI becomes the tutor; this
// server hands it the curated scaffold (order, goals, teaching plan per step)
// plus a telemetry channel for "the learner got stuck here" — the strongest
// feedback signal, fed back into the same loop as giscus/PRs.
//
// Single source of truth: reads the same content/topics/*.yaml the site builds
// from. Transport: stdio. Run: node mcp/server.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema, CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TOPICS_DIR = path.join(HERE, '..', 'content', 'topics');
const TELEMETRY = process.env.AIO_TELEMETRY || path.join(HERE, 'telemetry.jsonl');

// ---- content (same YAML the site uses) --------------------------------------
function loadTopics() {
  return fs.readdirSync(TOPICS_DIR)
    .filter((f) => /\.ya?ml$/.test(f))
    .map((f) => yaml.load(fs.readFileSync(path.join(TOPICS_DIR, f), 'utf8')))
    .filter((t) => t?.id)
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}
function getTopic(id) { return loadTopics().find((t) => t.id === id) || null; }
function flatSteps(t) {
  const out = [];
  for (const m of t.modules ?? [])
    for (const s of m.steps ?? []) out.push({ ...s, module: m.title });
  return out;
}

// The reframe that makes MCP better than copy-paste: the site's "paste this into
// your AI" prompt becomes the teaching plan for the AI that is ALREADY the tutor.
const TUTOR_GUIDANCE =
  'You are the tutor. Run this path ONE STEP AT A TIME. For each step: teach toward ' +
  'its goal using the step\'s teaching_plan, then check understanding with its quiz, ' +
  'then set the hands-on practice and WAIT for the learner before calling next_step. ' +
  'Adapt to the learner — the plan is a scaffold, not a script. If they struggle or ' +
  'seem confused, call report_stuck so the path can be improved.';

function stepView(t, s, idx, total) {
  return {
    topic: t.id, id: s.id, slug: s.slug, title: s.title,
    position: `${idx + 1} of ${total}`, module: s.module,
    goal: s.goal,
    teaching_plan: s.prompt?.trim() || '',   // the curated "how to teach this"
    quiz: s.quiz_prompt?.trim() || '',
    practice: s.practice || '',
    next_id: null,  // set by the caller
  };
}

// ---- tool implementations ----------------------------------------------------
function listPaths() {
  return loadTopics().map((t) => ({
    topic: t.id, title: t.title, tagline: t.tagline,
    status: t.status, steps: flatSteps(t).length,
  }));
}

function startPath(topic) {
  const t = getTopic(topic);
  if (!t) throw new Error(`Unknown topic "${topic}". Call list_paths first.`);
  const steps = flatSteps(t);
  const outline = t.modules.map((m) => ({
    module: m.title, steps: (m.steps ?? []).map((s) => s.title),
  }));
  const first = steps[0];
  return {
    topic: t.id, title: t.title, tagline: t.tagline, status: t.status,
    total_steps: steps.length, outline,
    tutor_guidance: TUTOR_GUIDANCE,
    first_step: first
      ? { ...stepView(t, first, 0, steps.length), next_id: steps[1]?.id ?? null }
      : null,
  };
}

function getStep(topic, stepId) {
  const t = getTopic(topic);
  if (!t) throw new Error(`Unknown topic "${topic}".`);
  const steps = flatSteps(t);
  const idx = steps.findIndex((s) => s.id === stepId || s.slug === stepId);
  if (idx < 0) throw new Error(`No step "${stepId}" in "${topic}".`);
  const v = stepView(t, steps[idx], idx, steps.length);
  v.next_id = steps[idx + 1]?.id ?? null;
  return v;
}

function nextStep(topic, afterId) {
  const t = getTopic(topic);
  if (!t) throw new Error(`Unknown topic "${topic}".`);
  const steps = flatSteps(t);
  const idx = steps.findIndex((s) => s.id === afterId || s.slug === afterId);
  if (idx < 0) throw new Error(`No step "${afterId}" in "${topic}".`);
  if (idx + 1 >= steps.length) {
    return { done: true, message: `That was the last step of "${t.title}". Path complete.` };
  }
  const v = stepView(t, steps[idx + 1], idx + 1, steps.length);
  v.next_id = steps[idx + 2]?.id ?? null;
  return v;
}

function reportStuck(topic, stepId, note) {
  const rec = {
    ts: new Date().toISOString(), kind: 'stuck',
    topic, step_id: stepId, note: note || '',
  };
  fs.appendFileSync(TELEMETRY, JSON.stringify(rec) + '\n');
  return { ok: true, message: 'Logged. Thanks — this helps improve the path.' };
}

// ---- MCP wiring --------------------------------------------------------------
const TOOLS = [
  { name: 'list_paths',
    description: 'List the available learning paths (topics) with their status and step count. Call this first to discover what can be taught.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'start_path',
    description: 'Begin a learning path. Returns the path outline, the tutor_guidance you must follow to teach it, and the first step. Use when the learner wants to start learning a topic.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string', description: 'Topic id, e.g. "splunk" (from list_paths).' } }, required: ['topic'], additionalProperties: false } },
  { name: 'get_step',
    description: 'Fetch one step by id or slug: its goal, teaching_plan, quiz and practice. Use to (re)load a specific step.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, step_id: { type: 'string', description: 'Step id or slug.' } }, required: ['topic', 'step_id'], additionalProperties: false } },
  { name: 'next_step',
    description: 'Advance to the step after the given one. Call only after the learner has done the current step\'s practice.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, after_id: { type: 'string', description: 'The id/slug of the step just completed.' } }, required: ['topic', 'after_id'], additionalProperties: false } },
  { name: 'report_stuck',
    description: 'Record that the learner struggled or got confused on a step (telemetry that improves the path). Call when the learner is stuck, the step is unclear, or content seems wrong.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' }, step_id: { type: 'string' }, note: { type: 'string', description: 'What went wrong, in one line.' } }, required: ['topic', 'step_id'], additionalProperties: false } },
];

const server = new Server(
  { name: 'ask-in-order', version: '0.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: a = {} } = req.params;
  try {
    let result;
    switch (name) {
      case 'list_paths': result = listPaths(); break;
      case 'start_path': result = startPath(a.topic); break;
      case 'get_step': result = getStep(a.topic, a.step_id); break;
      case 'next_step': result = nextStep(a.topic, a.after_id); break;
      case 'report_stuck': result = reportStuck(a.topic, a.step_id, a.note); break;
      default: throw new Error(`Unknown tool "${name}"`);
    }
    return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${e.message}` }] };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
console.error('ask-in-order MCP server ready (stdio)');
