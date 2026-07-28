import Anthropic from "@anthropic-ai/sdk";
import type { Provider, RunOutput } from "./types.ts";
import type { ProviderConfig } from "../config.ts";
import type { McpManager } from "../mcp/manager.ts";

// Claude API provider — the "kernel" model. When MCP servers are connected,
// their tools are exposed to Claude and executed in an agentic loop, so
// capabilities ("drivers") plug in without any provider code changes.
export class ClaudeProvider implements Provider {
  name: string;
  kind = "claude";
  private client: Anthropic;
  private model: string;
  private mcp?: McpManager;

  constructor(name: string, cfg: ProviderConfig, mcp?: McpManager) {
    this.name = name;
    this.model = cfg.model ?? "claude-opus-5";
    this.mcp = mcp;
    // Zero-arg client resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN,
    // or an `ant auth login` profile automatically.
    this.client = new Anthropic();
  }

  async available(): Promise<boolean> {
    return true; // a real call is the only true auth test
  }

  async run(prompt: string): Promise<RunOutput> {
    const tools = this.mcp?.toAnthropicTools() ?? [];
    const messages: Anthropic.Beta.BetaMessageParam[] = [
      { role: "user", content: prompt },
    ];
    let totalIn = 0;
    let totalOut = 0;

    // Agentic loop: keep going while Claude requests MCP tool calls.
    for (let turn = 0; turn < 25; turn++) {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        ...(tools.length > 0 ? { tools } : {}),
        messages,
      } as Parameters<typeof this.client.beta.messages.stream>[0]);

      const message = await stream.finalMessage();
      totalIn += message.usage.input_tokens;
      totalOut += message.usage.output_tokens;

      if (message.stop_reason === "refusal") {
        return {
          output: "[claude declined this request for safety reasons]",
          model: message.model,
        };
      }

      if (message.stop_reason !== "tool_use") {
        const text = message.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join("\n");
        return {
          output: text,
          model: message.model,
          usage: { inputTokens: totalIn, outputTokens: totalOut },
        };
      }

      // Execute every requested MCP tool, return all results in one user turn.
      messages.push({ role: "assistant", content: message.content });
      const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
      for (const block of message.content) {
        if (block.type !== "tool_use") continue;
        try {
          const output = await this.mcp!.callTool(
            block.name,
            block.input as Record<string, unknown>,
          );
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: output.slice(0, 100_000),
          });
        } catch (err) {
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: `Error: ${err instanceof Error ? err.message : String(err)}`,
            is_error: true,
          });
        }
      }
      messages.push({ role: "user", content: results });
    }
    throw new Error("Tool loop exceeded 25 turns");
  }
}
