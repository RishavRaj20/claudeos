<div align="center">

# ⚡ ClaudeOS

**The open-source agent operating system.**

*Claude is the kernel. Every AI tool is a process. All agents share one memory.*

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Node >= 23.6](https://img.shields.io/badge/node-%3E%3D23.6-brightgreen.svg)](https://nodejs.org)
[![Zero build step](https://img.shields.io/badge/build-none%20needed-orange.svg)](#quick-start)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#contributing)

<br/>

`one daemon` · `many agents` · `shared memory` · `MCP drivers`

</div>

---

## 🧠 What is this?

Every AI agent today lives in its own silo — Claude Code doesn't know what Gemini CLI did, your local Ollama model can't see what Codex wrote, and nothing remembers anything across tools.

**ClaudeOS treats your AI tools like an operating system treats processes:**

| OS concept | ClaudeOS |
|---|---|
| 🧬 **Kernel / scheduler** | A daemon that routes every task to the right backend via configurable rules |
| ⚙️ **Processes** | Existing CLI agents (Claude Code, Gemini CLI, Codex) wrapped as first-class providers — nothing reimplemented |
| 🔌 **Drivers** | Capabilities plug in as [MCP](https://modelcontextprotocol.io) servers — filesystem, browser, email, anything |
| 💾 **Shared memory** | SQLite index + markdown vault (`~/.claudeos/`) that **every agent reads and writes** — Obsidian-compatible |

### The demo that matters

```
$ claudeos run "write a one-line python script to reverse a string"
[claude-code] ✓  print(input()[::-1])          ← Claude Code wrote this

$ claudeos run "what script did the coding agent write earlier?" --provider ollama
[ollama / llama3.2] ✓  print(input()[::-1])    ← a LOCAL model recalled it
```

Two different AI backends. One memory. That's the point.

---

## 🚀 Quick start

**Requirements:** Node ≥ 23.6 (runs TypeScript natively — no build step). Optional: [Ollama](https://ollama.com) for local models, an `ANTHROPIC_API_KEY` for the direct API, Claude Code / Gemini CLI / Codex for agent processes.

```bash
git clone https://github.com/RishavRaj20/claudeos && cd claudeos
npm install
cp claudeos.config.example.json claudeos.config.json   # edit to taste
node src/cli.ts start                                  # daemon on :7777
```

Then, in another terminal:

```bash
node src/cli.ts run "explain CRDTs in 3 lines"          # auto-routed
node src/cli.ts run "summarize X" --provider ollama     # explicit + local
node src/cli.ts run "fix the bug in utils.py"           # → routes to claude-code
node src/cli.ts providers                               # who's alive?
node src/cli.ts runs                                    # task history
node src/cli.ts recall "that thing from yesterday"      # preview memory
node src/cli.ts mcp                                     # list drivers + tools
```

---

## ✨ Features

- **🎯 Smart routing** — regex rules map prompts to providers (`"fix the bug"` → Claude Code, `"summarize"` → local llama); first match wins, falls back to your default
- **🔋 Three provider types, one interface**
  - `claude` — Anthropic API (streaming, adaptive thinking, server-side refusal fallbacks)
  - `ollama` — any local model, fully offline and private
  - `cli` — wrap *any* CLI agent as a subprocess with a `{prompt}` template
- **🔌 MCP driver model** — declare servers in config (Claude Desktop format); the daemon connects at boot, discovers tools, hands them to the kernel model's agentic loop, and exposes direct calls:
  ```bash
  claudeos mcp call filesystem__read_text_file '{"path": "README.md"}'
  ```
- **🧠 Semantic memory injection** — every task automatically receives the most relevant past runs inside a `<claudeos-memory>` block, whoever produced them. Ranking is by embedding similarity (local `nomic-embed-text` via Ollama — fully private, no API), with keyword+recency fallback when Ollama is off. Past runs are auto-embedded at daemon startup.
- **📓 Human-readable memory** — every run is a markdown file with frontmatter; point Obsidian at `~/.claudeos/memory/` and browse your agents' entire history
- **📥 Driver registry** — `claudeos mcp registry` lists 9 curated drivers (fetch, github, puppeteer, sqlite, ...); `claudeos mcp install <name>` writes the config for you
- **⏱ Async tasks + live events** — `claudeos run "..." --async` returns instantly; follow with `claudeos task <id>` or stream every task's lifecycle over WebSocket with `claudeos watch`
- **🔗 Multi-step pipelines** — chain providers into workflows where each step's output feeds the next via `{input}` / `{prev}` / `{stepname}` templates:
  ```
  $ claudeos pipeline build "a python function is_palindrome(s)"
  ── research   [ollama] ✓        outline from a local model
  ── implement  [claude-code] ✓   def is_palindrome(s): ...
  ── verify     [claude-code] ✓   LGTM
  ```
- **🌐 Local HTTP + WS API** — `GET /status`, `GET /mcp`, `POST /run`, `POST /tasks`, `ws://:7777/ws`; the CLI is just a client, so any UI can attach (Tauri desktop app coming in phase 2)
- **📦 Zero build step** — modern Node runs the TypeScript directly; one runtime dependency worth naming (`@anthropic-ai/sdk`) plus the MCP SDK

---

## 🏗 Architecture

```
                ┌──────────────────────────────┐
   CLI ───────▶ │   daemon  (HTTP :7777)       │ ◀─────── UI (phase 2)
                │    └─ scheduler ("kernel")   │
                └───────┬──────────┬───────────┘
                        │ routes   │ persists
          ┌─────────────┼──────────┼──────────────┐
          ▼             ▼          │              ▼
    Claude API      Ollama         │         CLI agents
    (opus 5 +       (llama,        │         (claude-code,
     MCP tools)      granite...)   │          gemini, codex)
          │                        ▼
          │                 ~/.claudeos/
          └─ MCP drivers     ├─ claudeos.db    SQLite index (searchable)
             (filesystem,    └─ memory/*.md    markdown vault (Obsidian-ready)
              browser, ...)
```

## 🖥 Desktop app (phase 2)

A native [Tauri](https://tauri.app) dashboard lives in [desktop/](desktop/) — provider and MCP driver health, a run console (auto-route, pick a provider, or run a whole pipeline), live WebSocket event feed, and run history. It's a thin client over the daemon's API, so keep `claudeos start` running.

```bash
cd desktop
npm install
npm run tauri dev     # requires Rust (rustup.rs)
```

## ⚙️ Configuration

Everything lives in `claudeos.config.json` (gitignored — copy [claudeos.config.example.json](claudeos.config.example.json)):

```jsonc
{
  "defaultProvider": "claude",
  "providers": {
    "claude":      { "type": "claude", "model": "claude-opus-5" },
    "ollama":      { "type": "ollama", "model": "llama3.2" },
    "claude-code": { "type": "cli", "command": "claude", "args": ["-p", "{prompt}"] }
  },
  "routing": [
    { "match": "\\b(code|refactor|implement|debug)\\b", "provider": "claude-code" },
    { "match": "\\b(summarize|translate|classify)\\b",  "provider": "ollama" }
  ],
  "memory":     { "inject": true, "maxEntries": 3 },
  "mcpServers": {
    "filesystem": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"] }
  }
}
```

---

## 🗺 Roadmap

- [x] Daemon + CLI + provider abstraction (Claude API / Ollama / wrapped CLI agents)
- [x] Regex task routing with fallback
- [x] MCP client — capability drivers, exposed to the kernel model's agentic loop
- [x] Memory injection — cross-agent knowledge sharing on every task
- [x] `claudeos mcp install <name>` — one-command driver registry (9 curated MCP servers)
- [x] Async tasks + WebSocket streaming — `run --async`, `claudeos task`, `claudeos watch`
- [x] Embedding-based recall — semantic memory search via local Ollama embeddings (`nomic-embed-text`), with keyword fallback when Ollama is offline
- [x] Multi-step pipelines — research → implement → verify chains across providers, defined in config, streamed step-by-step over WebSocket
- [x] **Phase 2 (started):** Tauri desktop app (`desktop/`) — native dashboard over the daemon's HTTP/WS API: provider + MCP health, run console with auto-route/provider/pipeline selection, live event feed, run history
- [x] Phase 2 continued: live async runs in the UI (WebSocket-fed output), memory vault browser, in-app config editor, packaged `.app`/`.dmg` builds (`npm run tauri build`)
- [ ] Phase 2 next: per-token streaming, driver install from the UI, notifications

## 🤝 Contributing

This project is young and moving fast — perfect time to jump in. Open an issue, grab a roadmap item, or add a provider for your favorite agent (it's ~60 lines: implement `available()` and `run()` in [src/providers/](src/providers/types.ts)).

Inspired by [OpenHuman](https://github.com/tinyhumansai/openhuman) — ClaudeOS bets on orchestrating the agents you already use rather than replacing them.

## 📄 License

[Apache-2.0](LICENSE)
