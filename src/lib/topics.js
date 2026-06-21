import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';

const TOPICS_DIR = path.resolve('content/topics');

export function loadTopics() {
  return fs
    .readdirSync(TOPICS_DIR)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .map((f) => {
      const topic = yaml.load(fs.readFileSync(path.join(TOPICS_DIR, f), 'utf8'));
      if (!topic?.id || !topic?.title) {
        throw new Error(`Topic file ${f} is missing required "id" or "title"`);
      }
      topic.modules ??= [];
      topic.color ??= '#0f766e';
      for (const mod of topic.modules) mod.steps ??= [];
      return topic;
    })
    .sort((a, b) => (a.order ?? 99) - (b.order ?? 99));
}

export function stepCount(topic) {
  return topic.modules.reduce((n, m) => n + m.steps.length, 0);
}

// Immutable ids of every step in a topic — the stable join keys (progress, giscus).
export function stepIds(topic) {
  return topic.modules.flatMap((m) => m.steps.map((s) => s.id));
}

// First real step of the first "ready" topic — used as a live example on the homepage.
export function firstExample(topics) {
  for (const t of topics) {
    if (t.status !== 'ready') continue;
    for (const mod of t.modules) {
      if (mod.steps.length > 0) {
        return { topic: t, module: mod, step: mod.steps[0] };
      }
    }
  }
  return null;
}

// Flat list of steps with module context and prev/next links, for step pages.
export function flatSteps(topic) {
  const flat = [];
  for (const mod of topic.modules) {
    for (const step of mod.steps) {
      flat.push({ step, module: mod });
    }
  }
  return flat.map((entry, i) => ({
    ...entry,
    index: i,
    total: flat.length,
    prev: flat[i - 1]?.step ?? null,
    next: flat[i + 1]?.step ?? null,
  }));
}
