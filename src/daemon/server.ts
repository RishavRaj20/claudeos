import { createServer } from "node:http";
import { WebSocketServer } from "ws";
import type { ClaudeOSConfig } from "../config.ts";
import { buildProviders } from "../providers/index.ts";
import { McpManager } from "../mcp/manager.ts";
import { Scheduler } from "./scheduler.ts";
import { TaskManager, type TaskEvent } from "./tasks.ts";

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

  const server = createServer(async (req, res) => {
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

  // WebSocket: GET /ws — pushes task lifecycle events to every client.
  const wss = new WebSocketServer({ server, path: "/ws" });
  taskManager.on("event", (event: TaskEvent) => {
    const payload = JSON.stringify(event);
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(payload);
    }
  });

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
