# Ask in Order — MCP server

Run the curated learning paths *inside* your AI instead of copy-pasting prompts
from the website. Your AI becomes the tutor; this server hands it the curated
scaffold (order, goals, a teaching plan per step) and a telemetry channel for
"the learner got stuck here".

It reads the same `content/topics/*.yaml` the site builds from — one source of
truth, so a path improves in both places at once.

## Tools

| Tool | What it does |
|------|--------------|
| `list_paths` | discover available topics + step counts |
| `start_path` | begin a path: outline + tutor guidance + first step |
| `get_step` | load one step (goal, teaching plan, quiz, practice) |
| `next_step` | advance after the learner finishes a step |
| `report_stuck` | log that a step was confusing/wrong (feedback signal) |

## Connect it

**Claude Desktop / Cursor** — add to the MCP config (`claude_desktop_config.json`
or the editor's MCP settings):

```json
{
  "mcpServers": {
    "ask-in-order": {
      "command": "node",
      "args": ["/absolute/path/to/ask-in-order/mcp/server.mjs"]
    }
  }
}
```

**Claude Code** — from the repo root:

```bash
claude mcp add ask-in-order -- node mcp/server.mjs
```

Then just ask: *"Teach me Splunk, in order."* The AI calls `list_paths` →
`start_path` and runs the path one step at a time.

## Telemetry

`report_stuck` appends JSON lines to `mcp/telemetry.jsonl` (gitignored, local).
Override the path with `AIO_TELEMETRY=/some/file.jsonl`. This is the strongest
feedback signal — it feeds the same improvement loop as giscus comments and PRs.

## Develop

```bash
npm run mcp        # start the server (stdio)
npm run mcp:test   # spawn it and exercise every tool
```
