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

function parseRunArgs(args: string[]): { prompt: string; provider?: string; async: boolean } {
  let provider: string | undefined;
  let async = false;
  const parts: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--provider" || args[i] === "-p") {
      provider = args[++i];
    } else if (args[i] === "--async" || args[i] === "-a") {
      async = true;
    } else {
      parts.push(args[i]);
    }
  }
  return { prompt: parts.join(" "), provider, async };
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
      const { prompt, provider, async } = parseRunArgs(rest);
      if (!prompt) {
        console.error('Usage: claudeos run "your task" [--provider name] [--async]');
        process.exit(1);
      }
      if (async) {
        if (!(await daemonAlive())) {
          console.error("--async requires the daemon: start it with `claudeos start`");
          process.exit(1);
        }
        const res = await fetch(`${BASE}/tasks`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ prompt, provider }),
        });
        const task = (await res.json()) as { taskId: string };
        console.log(`task submitted: ${task.taskId}`);
        console.log(`  follow:  claudeos task ${task.taskId}`);
        console.log(`  stream:  claudeos watch`);
        return;
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

    case "pipeline": {
      // "claudeos pipeline"                -> list defined pipelines
      // "claudeos pipeline <name> "input"" -> run a pipeline via the daemon
      if (!(await daemonAlive())) {
        console.error("pipelines require the daemon: start it with `claudeos start`");
        process.exit(1);
      }
      if (rest.length === 0) {
        const res = await fetch(`${BASE}/pipelines`);
        const pipelines = (await res.json()) as Record<string, string[]>;
        if (Object.keys(pipelines).length === 0) {
          console.log("(no pipelines defined — add a `pipelines` block to claudeos.config.json)");
          return;
        }
        for (const [n, steps] of Object.entries(pipelines)) {
          console.log(`${n}:  ${steps.join(" → ")}`);
        }
        return;
      }
      const [pipelineName, ...inputParts] = rest;
      const input = inputParts.join(" ");
      if (!input) {
        console.error('Usage: claudeos pipeline <name> "input"');
        process.exit(1);
      }
      console.log(`running pipeline "${pipelineName}" ... (watch live: claudeos watch)\n`);
      const res = await fetch(`${BASE}/pipelines/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: pipelineName, input }),
      });
      const result = (await res.json()) as {
        ok?: boolean;
        error?: string;
        steps?: Array<{ step: string; record: { provider: string; ok: boolean; output: string } }>;
        output?: string;
      };
      if (result.error) {
        console.error(result.error);
        process.exit(1);
      }
      for (const s of result.steps ?? []) {
        console.log(`── ${s.step}  [${s.record.provider}] ${s.record.ok ? "✓" : "✗"}`);
        console.log(s.record.output.slice(0, 400).trim());
        console.log("");
      }
      console.log(`pipeline ${result.ok ? "✓ complete" : "✗ failed"}`);
      break;
    }

    case "task": {
      const id = rest[0];
      if (!id) {
        // No id: list all async tasks
        const res = await fetch(`${BASE}/tasks`);
        const tasks = (await res.json()) as Array<{ taskId: string; status: string; prompt: string }>;
        for (const t of tasks) console.log(`${t.taskId}  ${t.status.padEnd(8)} ${t.prompt.slice(0, 60)}`);
        return;
      }
      const res = await fetch(`${BASE}/tasks/${id}`);
      const task = (await res.json()) as {
        status: string;
        record?: { provider: string; model?: string; ok: boolean; output: string };
        error?: string;
      };
      if (task.error) {
        console.error(task.error);
        process.exit(1);
      }
      console.log(`status: ${task.status}`);
      if (task.record) {
        console.log(`\n[${task.record.provider}${task.record.model ? ` / ${task.record.model}` : ""}] ${task.record.ok ? "✓" : "✗"}\n`);
        console.log(task.record.output);
      }
      break;
    }

    case "watch": {
      if (!(await daemonAlive())) {
        console.error("watch requires the daemon: start it with `claudeos start`");
        process.exit(1);
      }
      console.log(`watching ws://localhost:${config.port}/ws  (Ctrl+C to stop)\n`);
      const ws = new WebSocket(`ws://localhost:${config.port}/ws`);
      ws.addEventListener("message", (msg) => {
        const event = JSON.parse(String(msg.data)) as {
          type: string;
          task?: { taskId: string; status: string; prompt: string; record?: { provider: string; ok: boolean; output: string } };
          name?: string;
          step?: string;
          provider?: string;
          ok?: boolean;
        };
        if (event.task) {
          const t = event.task;
          if (event.type === "task.finished" && t.record) {
            console.log(`${event.type}  [${t.record.provider}] ${t.record.ok ? "✓" : "✗"}  ${t.prompt.slice(0, 50)}`);
            console.log(`  ${t.record.output.slice(0, 200).replace(/\n+/g, " ")}\n`);
          } else {
            console.log(`${event.type}  ${t.taskId.slice(0, 8)}  ${t.prompt.slice(0, 50)}`);
          }
        } else if (event.type.startsWith("pipeline.")) {
          const parts = [event.type.padEnd(24), event.name];
          if (event.step) parts.push(`step=${event.step}`);
          if (event.provider) parts.push(`[${event.provider}]`);
          if (event.ok !== undefined) parts.push(event.ok ? "✓" : "✗");
          console.log(parts.join("  "));
        } else {
          console.log(JSON.stringify(event));
        }
      });
      ws.addEventListener("close", () => process.exit(0));
      // keep process alive
      await new Promise(() => {});
      break;
    }

    case "recall": {
      const query = rest.join(" ");
      if (!query) {
        console.error('Usage: claudeos recall "query"');
        process.exit(1);
      }
      const scheduler = new Scheduler(config, new Map());
      const entries = await scheduler.recall(query);
      if (entries.length === 0) {
        console.log("(no relevant memories)");
        return;
      }
      for (const e of entries) {
        console.log(`${e.method} ${e.score.toFixed(2)}  [${e.provider}] ${e.startedAt.slice(0, 16)}`);
        console.log(`  task:   ${e.prompt.slice(0, 100)}`);
        console.log(`  result: ${e.output.slice(0, 160).replace(/\n+/g, " ")}\n`);
      }
      break;
    }

    case "mcp": {
      // "claudeos mcp"                      -> list servers + tools (daemon)
      // "claudeos mcp registry"             -> browse installable drivers
      // "claudeos mcp install <name>"       -> add a driver to config
      // "claudeos mcp remove <name>"        -> remove a driver from config
      // "claudeos mcp call <tool> '<json>'" -> call a tool via the daemon
      if (rest[0] === "registry") {
        const { REGISTRY } = await import("./mcp/registry.ts");
        for (const [name, e] of Object.entries(REGISTRY)) {
          console.log(`${name.padEnd(22)} ${e.description}`);
        }
        console.log(`\nInstall with: claudeos mcp install <name>`);
        return;
      }
      if (rest[0] === "install" || rest[0] === "remove") {
        const { installServer, removeServer } = await import("./mcp/registry.ts");
        const name = rest[1];
        if (!name) {
          console.error(`Usage: claudeos mcp ${rest[0]} <name>   (see: claudeos mcp registry)`);
          process.exit(1);
        }
        if (rest[0] === "install") {
          const entry = installServer(name);
          console.log(`✓ installed driver "${name}" — ${entry.description}`);
          if (entry.note) console.log(`  note: ${entry.note}`);
        } else {
          removeServer(name);
          console.log(`✓ removed driver "${name}"`);
        }
        console.log(`  restart the daemon to apply`);
        return;
      }
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
  claudeos run "task" --async             Submit and return immediately
  claudeos task [id]                      Async task status / list
  claudeos pipeline [name "input"]        List or run multi-step pipelines
  claudeos watch                          Live-stream task events (WebSocket)
  claudeos runs                           Recent task history
  claudeos memory                         List shared memory vault entries
  claudeos recall "query"                 Preview memories injected for a task
  claudeos mcp                            List MCP servers and tools
  claudeos mcp registry                   Browse installable drivers
  claudeos mcp install|remove <name>      Add/remove a driver in config
  claudeos mcp call <tool> '<json>'       Call an MCP tool directly
`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
