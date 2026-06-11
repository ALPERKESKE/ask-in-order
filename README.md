# Ask in Order

**Learn anything with the AI you already use.**

Everyone has access to a powerful AI tutor (ChatGPT, Claude, Gemini) — but most
people don't know *what to ask, in what order*. Ask in Order is an open-source
collection of curated learning paths: ordered sequences of carefully engineered
prompts that turn your AI into a structured tutor.

- **No accounts, no API keys, no vendor lock-in** — copy each prompt into the AI you already use.
- **Each step**: a clear goal, a tutor prompt (explain → quiz → wait for answers), a self-test prompt, and a hands-on practice task.
- **Progress** is stored in your browser (localStorage).
- **All content is plain YAML** under `content/topics/` — improving a path is a pull request away.

## Current paths

| Topic | Status |
|-------|--------|
| Splunk | ✅ 22 steps, 6 modules |
| Kubernetes | 🚧 skeleton — contributions welcome |
| Docker | 🚧 skeleton — contributions welcome |
| Linux | 🚧 skeleton — contributions welcome |

## Run locally

```bash
npm install
npm run dev        # dev server on :4321
npm run build      # static output in dist/
```

Or with Docker:

```bash
docker compose up -d --build   # serves on :8085
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: paths are YAML files,
steps are list entries, and "this question should come earlier" is a perfectly
good pull request.

## License

MIT
