import type { Provider } from "./types.ts";
import type { ClaudeOSConfig } from "../config.ts";
import type { McpManager } from "../mcp/manager.ts";
import { ClaudeProvider } from "./claude.ts";
import { OllamaProvider } from "./ollama.ts";
import { CliAgentProvider } from "./cli-agent.ts";

export function buildProviders(config: ClaudeOSConfig, mcp?: McpManager): Map<string, Provider> {
  const providers = new Map<string, Provider>();
  for (const [name, cfg] of Object.entries(config.providers)) {
    switch (cfg.type) {
      case "claude":
        providers.set(name, new ClaudeProvider(name, cfg, mcp));
        break;
      case "ollama":
        providers.set(name, new OllamaProvider(name, cfg));
        break;
      case "cli":
        providers.set(name, new CliAgentProvider(name, cfg));
        break;
      default:
        throw new Error(`Unknown provider type for "${name}"`);
    }
  }
  return providers;
}
