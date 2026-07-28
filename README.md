# ClaudeOS

**An open-source agent operating system.** Claude is the kernel; every AI tool — Claude Code, Codex CLI, Gemini CLI, local Ollama models — is a process it can schedule. All agents share one memory.

> Phase 1: TypeScript daemon + CLI. Phase 2: Rust core + Tauri desktop UI.

## Why

Projects like [OpenHuman](https://github.com/tinyhumansai/openhuman) build a single agent harness. ClaudeOS takes the OS analogy further:

- **Kernel / scheduler** — a daemon that routes each task to the right backend based on configurable rules
- **Processes** — existing CLI agents wrapped as first-class providers (no reimplementation)
- **Drivers** — capabilities arrive as MCP servers (roadmap)
- **Shared memory** — SQLite index + markdown vault in `~/.claudeos/`, readable and writable by every agent, Obsidian-compatible

## Requirements

- Node.js ≥ 23.6 (runs TypeScript natively — no build step)
- An Anthropic API key (`ANTHROPIC_API_KEY`) or `ant auth login` profile
- Optional: [Ollama](https://ollama.com) for local models, Claude Code / Gemini CLI / Codex CLI for agent processes

## Quick start

```bash
npm install
cp claudeos.config.example.json claudeos.config.json   # then edit to taste
node src/cli.ts start           # start the daemon on :7777
```

In another terminal:

```bash
node src/cli.ts providers                       # who's alive?
node src/cli.ts run "explain CRDTs in 3 lines"  # auto-routes (default: claude)
node src/cli.ts run "summarize this repo" --provider ollama
node src/cli.ts run "fix the bug in utils.py"   # routes to claude-code via rules
node src/cli.ts runs                            # task history
node src/cli.ts memory                          # shared memory vault
```

## Configuration

Everything lives in `claudeos.config.json` (gitignored — copy [claudeos.config.example.json](claudeos.config.example.json) to create yours):

- `providers` — the backends. Three types: `claude` (Anthropic API), `ollama` (local HTTP), `cli` (any subprocess agent; `{prompt}` is templated into args)
- `routing` — regex rules that map prompts to providers; first match wins, falls back to `defaultProvider`
- `mcpServers` — capability "drivers" (Claude Desktop-style entries: `command`/`args` for stdio, or `url` for streamable HTTP). The daemon connects at startup, discovers tools, exposes them to the Claude provider's agentic loop, and lets you call them directly:

  ```bash
  claudeos mcp                                                      # list servers + tools
  claudeos mcp call filesystem__read_text_file '{"path": "README.md"}'
  ```

- `port` — daemon port

## Architecture

```
            ┌───────────────────────────┐
  CLI ────▶ │  daemon (HTTP :7777)      │
  UI  ────▶ │   └─ scheduler (kernel)   │
            └──────┬──────────┬─────────┘
                   │ routes   │ persists
        ┌──────────┼─────────┐│
        ▼          ▼         ▼▼
   Claude API   Ollama    CLI agents      ~/.claudeos/
   (opus 5)     (local)   (claude-code,    ├─ claudeos.db   (SQLite index)
                           gemini, codex)  └─ memory/*.md   (shared vault)
```

## Roadmap

- [x] MCP client — capability "drivers" via `mcpServers` in config; tools exposed to the Claude provider's agentic loop and callable directly (`claudeos mcp`)
- [ ] MCP registry — one-command install of new drivers
- [x] Memory injection — relevant past runs are auto-retrieved (keyword + recency scoring) and injected into every task's context, so agents share knowledge across backends (`claudeos recall` previews it)
- [ ] Embedding-based recall (via Ollama `nomic-embed-text`) to replace keyword scoring
- [ ] Async tasks + streaming over WebSocket
- [ ] Multi-step pipelines (research → implement → verify across providers)
- [ ] Phase 2: Rust core, Tauri desktop UI

## License

Apache-2.0
