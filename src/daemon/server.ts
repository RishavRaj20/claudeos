import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { WebSocketServer } from "ws";
import { PROJECT_ROOT, type ClaudeOSConfig } from "../config.ts";
import { Vault } from "../memory/vault.ts";
import { buildProviders } from "../providers/index.ts";
import { McpManager } from "../mcp/manager.ts";
import { Scheduler } from "./scheduler.ts";
import { TaskManager, type TaskEvent, type TaskDeltaEvent } from "./tasks.ts";
import { runPipeline } from "./pipeline.ts";

// The ClaudeOS daemon: a local HTTP API any client (CLI today, Tauri UI in
// phase 2) can attach to.
//
//   GET  /status     -> daemon uptime, run count, provider + MCP health
//   GET  /providers  -> provider availability
//   GET  /runs       -> recent task records
//   GET  /mcp        -> connected MCP servers + discovered tools
//   POST /mcp/call   -> {tool, args} call an MCP tool directly
//   POST /run        -> {prompt, provider?} run a task, wait, return record

export async function startDaemon(config: ClaudeOSConfig): Promise<void> {
  const mcp = new McpManager();
  if (config.mcpServers && Object.keys(config.mcpServers).length > 0) {
    console.log(`connecting MCP servers: ${Object.keys(config.mcpServers).join(", ")} ...`);
    await mcp.connect(config.mcpServers);
  }

  const providers = buildProviders(config, mcp);
  const scheduler = new Scheduler(config, providers);
  const taskManager = new TaskManager(scheduler);
  const startedAt = Date.now();

  // Backfill embeddings for past runs (best-effort, non-blocking).
  void scheduler
    .backfillEmbeddings()
    .then((n) => n > 0 && console.log(`   embedded ${n} past run(s) for semantic recall`))
    .catch(() => {});

  const server = createServer(async (req, res) => {
    // CORS: the daemon is a local API consumed by browser-based clients
    // (the Tauri dashboard, dev tools). Loopback-only, so * is fine.
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    const readBody = async (): Promise<Record<string, unknown>> => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return JSON.parse(raw || "{}");
    };

    try {
      if (req.method === "GET" && req.url === "/status") {
        send(200, {
          ok: true,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          totalRuns: scheduler.runCount(),
          providers: await scheduler.providerStatus(),
          mcp: mcp.status(),
        });
      } else if (req.method === "GET" && req.url === "/providers") {
        send(200, await scheduler.providerStatus());
      } else if (req.method === "GET" && req.url === "/mcp") {
        send(200, {
          servers: mcp.status(),
          tools: mcp.listTools().map((t) => ({
            name: t.name,
            server: t.server,
            description: t.description.split("\n")[0].slice(0, 120),
          })),
        });
      } else if (req.method === "POST" && req.url === "/mcp/call") {
        const body = (await readBody()) as { tool?: string; args?: Record<string, unknown> };
        if (!body.tool) {
          send(400, { error: "Missing 'tool' (namespaced, e.g. filesystem__read_file)" });
          return;
        }
        const output = await mcp.callTool(body.tool, body.args ?? {});
        send(200, { ok: true, output });
      } else if (req.method === "POST" && req.url === "/tasks") {
        // Async: returns immediately with a taskId; follow via WS or GET /tasks/:id
        const body = (await readBody()) as { prompt?: string; provider?: string };
        if (!body.prompt) {
          send(400, { error: "Missing 'prompt'" });
          return;
        }
        send(202, taskManager.submit(body.prompt, body.provider));
      } else if (req.method === "GET" && req.url?.startsWith("/tasks/")) {
        const task = taskManager.get(req.url.slice("/tasks/".length));
        if (!task) send(404, { error: "No such task" });
        else send(200, task);
      } else if (req.method === "GET" && req.url === "/tasks") {
        send(200, taskManager.list());
      } else if (req.method === "GET" && req.url === "/memory") {
        send(200, new Vault().list(100));
      } else if (req.method === "GET" && req.url?.startsWith("/memory/")) {
        // basename() prevents path traversal out of the vault dir
        const file = basename(decodeURIComponent(req.url.slice("/memory/".length)));
        try {
          send(200, { name: file, content: new Vault().read(file) });
        } catch {
          send(404, { error: "No such memory entry" });
        }
      } else if (req.method === "GET" && req.url === "/config") {
        send(200, config);
      } else if (req.method === "PUT" && req.url === "/config") {
        const body = await readBody();
        for (const field of ["port", "defaultProvider", "providers"]) {
          if (!(field in body)) {
            send(400, { error: `Config must include "${field}"` });
            return;
          }
        }
        writeFileSync(
          join(PROJECT_ROOT, "claudeos.config.json"),
          JSON.stringify(body, null, 2) + "\n",
        );
        send(200, { ok: true, note: "Saved. Restart the daemon to apply." });
      } else if (req.method === "GET" && req.url === "/pipelines") {
        send(200, Object.fromEntries(
          Object.entries(config.pipelines ?? {}).map(([n, steps]) => [
            n,
            steps.map((s) => `${s.name}${s.provider ? ` (${s.provider})` : ""}`),
          ]),
        ));
      } else if (req.method === "POST" && req.url === "/pipelines/run") {
        const body = (await readBody()) as { name?: string; input?: string };
        if (!body.name || !body.input) {
          send(400, { error: "Missing 'name' or 'input'" });
          return;
        }
        const result = await runPipeline(scheduler, config, body.name, body.input, broadcast);
        send(result.ok ? 200 : 500, result);
      } else if (req.method === "GET" && req.url?.startsWith("/runs")) {
        send(200, scheduler.recentRuns());
      } else if (req.method === "POST" && req.url === "/run") {
        const body = (await readBody()) as { prompt?: string; provider?: string };
        if (!body.prompt) {
          send(400, { error: "Missing 'prompt'" });
          return;
        }
        const record = await scheduler.run(body.prompt, body.provider);
        send(record.ok ? 200 : 500, record);
      } else {
        send(404, { error: "Not found" });
      }
    } catch (err) {
      send(500, { error: err instanceof Error ? err.message : String(err) });
    }
  });

  // WebSocket: GET /ws — pushes task + pipeline lifecycle events to clients.
  const wss = new WebSocketServer({ server, path: "/ws" });
  const broadcast = (event: unknown) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  };
  taskManager.on("event", (event: TaskEvent | TaskDeltaEvent) => broadcast(event));

  server.listen(config.port, () => {
    const toolCount = mcp.listTools().length;
    console.log(`⚡ ClaudeOS daemon listening on http://localhost:${config.port}`);
    console.log(`   providers: ${[...providers.keys()].join(", ")}`);
    console.log(`   mcp:       ${toolCount} tools from ${Object.keys(mcp.status()).length} server(s)`);
    console.log(`   memory:    ~/.claudeos/  (sqlite index + markdown vault)`);
  });

  const shutdown = async () => {
    await mcp.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
