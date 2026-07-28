#!/usr/bin/env node
import { loadConfig } from "./config.ts";
import { startDaemon } from "./daemon/server.ts";
import { buildProviders } from "./providers/index.ts";
import { Scheduler } from "./daemon/scheduler.ts";
import { Vault, VAULT_DIR_PATH } from "./memory/vault.ts";

const config = loadConfig();
const BASE = `http://localhost:${config.port}`;
const [, , command, ...rest] = process.argv;

async function daemonAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function parseRunArgs(args: string[]): { prompt: string; provider?: string } {
  let provider: string | undefined;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" || args[i] === "-p") {
      provider = args[++i];
    } else {
      parts.push(args[i]);
    }
  }
  return { prompt: parts.join(" "), provider };
}

async function main(): Promise<void> {
  switch (command) {
    case "start": {
      await startDaemon(config);
      break;
    }

    case "status": {
      if (!(await daemonAlive())) {
        console.log("daemon: not running  (start with: claudeos start)");
        return;
      }
      const res = await fetch(`${BASE}/status`);
      console.log(JSON.stringify(await res.json(), null, 2));
      break;
    }

    case "providers": {
      if (await daemonAlive()) {
        const res = await fetch(`${BASE}/providers`);
        console.log(JSON.stringify(await res.json(), null, 2));
      } else {
        const scheduler = new Scheduler(config, buildProviders(config));
        console.log(JSON.stringify(await scheduler.providerStatus(), null, 2));
      }
      break;
    }

    case "run": {
      const { prompt, provider } = parseRunArgs(rest);
      if (!prompt) {
        console.error('Usage: claudeos run "your task" [--provider name]');
        process.exit(1);
      }
      let record;
      if (await daemonAlive()) {
        const res = await fetch(`${BASE}/run`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, provider }),
        });
        record = await res.json();
      } else {
        // No daemon? Run in-process so the CLI always works.
        const scheduler = new Scheduler(config, buildProviders(config));
        record = await scheduler.run(prompt, provider);
      }
      console.log(`\n[${record.provider}${record.model ? ` / ${record.model}` : ""}] ${record.ok ? "✓" : "✗"}\n`);
      console.log(record.output);
      break;
    }

    case "runs": {
      const scheduler = new Scheduler(config, buildProviders(config));
      for (const r of scheduler.recentRuns()) {
        console.log(`${r.startedAt}  [${r.provider}] ${r.ok ? "✓" : "✗"}  ${r.prompt.slice(0, 60)}`);
      }
      break;
    }

    case "recall": {
      const query = rest.join(" ");
      if (!query) {
        console.error('Usage: claudeos recall "query"');
        process.exit(1);
      }
      const scheduler = new Scheduler(config, new Map());
      const entries = scheduler.recall(query);
      if (entries.length === 0) {
        console.log("(no relevant memories)");
        return;
      }
      for (const e of entries) {
        console.log(`score ${e.score.toFixed(1)}  [${e.provider}] ${e.startedAt.slice(0, 16)}`);
        console.log(`  task:   ${e.prompt.slice(0, 100)}`);
        console.log(`  result: ${e.output.slice(0, 160).replace(/\n+/g, " ")}\n`);
      }
      break;
    }

    case "mcp": {
      // "claudeos mcp"                      -> list servers + tools (daemon)
      // "claudeos mcp call <tool> '<json>'" -> call a tool via the daemon
      if (!(await daemonAlive())) {
        console.error("MCP requires the daemon: start it with `claudeos start`");
        process.exit(1);
      }
      if (rest[0] === "call") {
        const tool = rest[1];
        const args = rest[2] ? JSON.parse(rest[2]) : {};
        if (!tool) {
          console.error(`Usage: claudeos mcp call <server__tool> '{"arg": "value"}'`);
          process.exit(1);
        }
        const res = await fetch(`${BASE}/mcp/call`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ tool, args }),
        });
        const data = (await res.json()) as { ok?: boolean; output?: string; error?: string };
        console.log(data.output ?? data.error);
      } else {
        const res = await fetch(`${BASE}/mcp`);
        const data = (await res.json()) as {
          servers: Record<string, { connected: boolean; tools: number; error?: string }>;
          tools: Array<{ name: string; description: string }>;
        };
        for (const [name, s] of Object.entries(data.servers)) {
          console.log(`${s.connected ? "●" : "○"} ${name}  (${s.tools} tools)${s.error ? `  ERROR: ${s.error}` : ""}`);
        }
        console.log("");
        for (const t of data.tools) console.log(`  ${t.name}  — ${t.description}`);
      }
      break;
    }

    case "memory": {
      const vault = new Vault();
      console.log(`vault: ${VAULT_DIR_PATH}\n`);
      for (const f of vault.list()) console.log(f);
      break;
    }

    default:
      console.log(`ClaudeOS — agent operating system (phase 1)

Usage:
  claudeos start                          Start the daemon (foreground)
  claudeos status                         Daemon status + provider health
  claudeos providers                      List providers and availability
  claudeos run "task" [--provider name]   Route a task (auto or explicit)
  claudeos runs                           Recent task history
  claudeos memory                         List shared memory vault entries
  claudeos recall "query"                 Preview memories injected for a task
  claudeos mcp                            List MCP servers and tools
  claudeos mcp call <tool> '<json>'       Call an MCP tool directly
`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
