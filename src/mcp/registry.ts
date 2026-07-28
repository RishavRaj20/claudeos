import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PROJECT_ROOT, type ClaudeOSConfig, type McpServerEntry } from "../config.ts";

// Curated driver registry — one-command install of well-known MCP servers.
// `claudeos mcp install <name>` writes the entry into claudeos.config.json.
// Entries with <placeholders> are highlighted so users know what to edit.

export interface RegistryEntry extends McpServerEntry {
  description: string;
  note?: string;
}

export const REGISTRY: Record<string, RegistryEntry> = {
  filesystem: {
    description: "Read/write files in allowed directories",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "<absolute-path-to-allow>"],
    note: "Replace <absolute-path-to-allow> with the directory the agent may access",
  },
  fetch: {
    description: "Fetch web pages as markdown",
    command: "uvx",
    args: ["mcp-server-fetch"],
    note: "Requires uv (https://docs.astral.sh/uv). Alternative: npx -y @tokenizin/mcp-npx-fetch",
  },
  memory: {
    description: "Knowledge-graph memory (entities + relations)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
  },
  git: {
    description: "Read and search git repositories",
    command: "uvx",
    args: ["mcp-server-git", "--repository", "<repo-path>"],
    note: "Replace <repo-path> with a repository path",
  },
  github: {
    description: "GitHub issues, PRs, repos (needs a token)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-github"],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: "<your-token>" },
    note: "Set GITHUB_PERSONAL_ACCESS_TOKEN in the env block",
  },
  puppeteer: {
    description: "Browser automation (navigate, screenshot, click)",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-puppeteer"],
  },
  sqlite: {
    description: "Query a SQLite database",
    command: "uvx",
    args: ["mcp-server-sqlite", "--db-path", "<db-path>"],
    note: "Replace <db-path> with your .db file",
  },
  "sequential-thinking": {
    description: "Structured step-by-step reasoning scratchpad",
    command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
  },
  time: {
    description: "Current time and timezone conversions",
    command: "uvx",
    args: ["mcp-server-time"],
  },
};

const CONFIG_PATH = join(PROJECT_ROOT, "claudeos.config.json");

function readConfigRaw(): ClaudeOSConfig {
  return JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
}

function writeConfigRaw(config: ClaudeOSConfig): void {
  writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function installServer(name: string): RegistryEntry {
  const entry = REGISTRY[name];
  if (!entry) {
    const known = Object.keys(REGISTRY).join(", ");
    throw new Error(`Unknown driver "${name}". Available: ${known}`);
  }
  const config = readConfigRaw();
  config.mcpServers = config.mcpServers ?? {};
  if (config.mcpServers[name]) {
    throw new Error(`Driver "${name}" is already installed`);
  }
  const { description: _d, note: _n, ...serverEntry } = entry;
  config.mcpServers[name] = serverEntry;
  writeConfigRaw(config);
  return entry;
}

export function removeServer(name: string): void {
  const config = readConfigRaw();
  if (!config.mcpServers?.[name]) {
    throw new Error(`Driver "${name}" is not installed`);
  }
  delete config.mcpServers[name];
  writeConfigRaw(config);
}
