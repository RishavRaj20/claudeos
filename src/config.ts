import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface ProviderConfig {
  type: "claude" | "ollama" | "cli";
  model?: string;
  baseUrl?: string;
  command?: string;
  args?: string[];
  timeoutMs?: number;
}

export interface RoutingRule {
  match: string; // regex tested against the prompt (case-insensitive)
  provider: string;
}

export interface McpServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
}

export interface MemoryConfig {
  inject: boolean;
  maxEntries?: number;
  maxCharsPerEntry?: number;
}

export interface ClaudeOSConfig {
  port: number;
  defaultProvider: string;
  providers: Record<string, ProviderConfig>;
  routing: RoutingRule[];
  mcpServers?: Record<string, McpServerEntry>;
  memory?: MemoryConfig;
}

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "..");

export function loadConfig(): ClaudeOSConfig {
  const path = join(ROOT, "claudeos.config.json");
  if (!existsSync(path)) {
    throw new Error(`Missing config file: ${path}`);
  }
  return JSON.parse(readFileSync(path, "utf-8")) as ClaudeOSConfig;
}

export const PROJECT_ROOT = ROOT;
