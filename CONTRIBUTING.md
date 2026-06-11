# Contributing to Ask in Order

Every learning path is a YAML file in `content/topics/`. No CMS, no database —
if you can edit a text file, you can improve a path.

## Topic file format

```yaml
id: splunk            # URL slug, must match filename
order: 1              # position on the homepage
title: Splunk
tagline: One-line description shown on the topic card.
status: ready         # "ready" or "skeleton"
modules:
  - title: Foundations
    steps:
      - slug: what-is-splunk        # URL slug, unique within the topic
        title: "What Splunk actually is"
        goal: "One or two sentences: what the learner can do after this step."
        prompt: |
          The main tutor prompt. See prompt rules below.
        quiz_prompt: |
          Optional self-test prompt.
        practice: "Optional one-line hands-on task in the real world."
```

## Prompt rules

These are what make the site worth using. Every `prompt` must:

1. **Carry context** — start with "I'm learning X, so far I know A and B."
   The AI tailors depth to this.
2. **Assign a tutor role** — "act as my instructor", "teach me", not "tell me about".
3. **End interactively** — the AI should quiz the learner and *wait for answers*
   ("ask me 3 questions, one at a time, and wait for my answer").
4. **Be vendor-neutral** — must work equally in ChatGPT, Claude and Gemini.
   No model-specific features.
5. **Prefer runnable examples** — if the topic has a free sandbox
   (Splunk's `_internal`, a local Docker, a VM), examples should run there.

## Ways to contribute

- **Improve a prompt** — small PRs welcome, explain what got better.
- **Reorder steps** — allowed and encouraged, but the PR description must argue
  *why* the new order teaches better.
- **Fill a skeleton** — pick a module in a skeleton topic and write its steps.
- **New topic** — open an issue first with the proposed module outline.

## Decision making

Maintainers settle ordering disputes after discussion in the PR. Quality bar
for merging: would *you* have learned faster with this change?
