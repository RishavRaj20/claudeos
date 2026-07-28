import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// MCP is the "driver model" of ClaudeOS: every capability (filesystem, browser,
// email, ...) is an MCP server declared in claudeos.config.json. The manager
// connects to each at daemon start, discovers tools, and exposes a unified
// call surface. Tool names are namespaced "server__tool" so multiple servers
// can coexist in one model context.

export interface McpServerConfig {
  command?: string; // stdio transport
  args?: string[];
  env?: Record<string, string>;
  url?: string; // streamable HTTP transport
}

export interface McpToolInfo {
  server: string;
  name: string; // namespaced: server__tool
  rawName: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

const NS = "__";

export class McpManager {
  private clients = new Map<string, Client>();
  private tools: McpToolInfo[] = [];
  private errors = new Map<string, string>();

  async connect(servers: Record<string, McpServerConfig>): Promise<void> {
    await Promise.all(
      Object.entries(servers).map(async ([name, cfg]) => {
        try {
          const client = new Client({ name: "claudeos", version: "0.1.0" });
          if (cfg.url) {
            await client.connect(new StreamableHTTPClientTransport(new URL(cfg.url)));
          } else if (cfg.command) {
            await client.connect(
              new StdioClientTransport({
                command: cfg.command,
                args: cfg.args ?? [],
                env: { ...process.env as Record<string, string>, ...cfg.env },
                stderr: "ignore",
              }),
            );
          } else {
            throw new Error("server needs either 'command' or 'url'");
          }
          this.clients.set(name, client);
          const { tools } = await client.listTools();
          for (const t of tools) {
            this.tools.push({
              server: name,
              name: `${name}${NS}${t.name}`,
              rawName: t.name,
              description: t.description ?? "",
              inputSchema: (t.inputSchema ?? { type: "object" }) as Record<string, unknown>,
            });
          }
        } catch (err) {
          this.errors.set(name, err instanceof Error ? err.message : String(err));
        }
      }),
    );
  }

  listTools(): McpToolInfo[] {
    return this.tools;
  }

  status(): Record<string, { connected: boolean; tools: number; error?: string }> {
    const out: Record<string, { connected: boolean; tools: number; error?: string }> = {};
    for (const name of this.clients.keys()) {
      out[name] = { connected: true, tools: this.tools.filter((t) => t.server === name).length };
    }
    for (const [name, error] of this.errors) {
      out[name] = { connected: false, tools: 0, error };
    }
    return out;
  }

  /** Call a tool by its namespaced name ("server__tool") or by (server, rawName). */
  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<string> {
    const tool = this.tools.find((t) => t.name === namespacedName);
    if (!tool) throw new Error(`Unknown MCP tool "${namespacedName}"`);
    const client = this.clients.get(tool.server);
    if (!client) throw new Error(`MCP server "${tool.server}" not connected`);
    const result = await client.callTool({ name: tool.rawName, arguments: args });
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = (content ?? [])
      .map((c) => (c.type === "text" ? c.text ?? "" : `[${c.type} content]`))
      .join("\n");
    if (result.isError) throw new Error(text || "MCP tool returned an error");
    return text;
  }

  /** Map MCP tools to Anthropic Messages API tool definitions. */
  toAnthropicTools(): Array<{ name: string; description: string; input_schema: Record<string, unknown> }> {
    return this.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema,
    }));
  }

  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close().catch(() => {})));
  }
}
