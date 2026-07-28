import type { Provider, RunOutput } from "./types.ts";
import type { ProviderConfig } from "../config.ts";

// Local model provider via Ollama's HTTP API. Fully offline/private.
export class OllamaProvider implements Provider {
  name: string;
  kind = "ollama";
  private baseUrl: string;
  private model: string;

  constructor(name: string, cfg: ProviderConfig) {
    this.name = name;
    this.baseUrl = cfg.baseUrl ?? "http://localhost:11434";
    this.model = cfg.model ?? "llama3.2";
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, {
        signal: AbortSignal.timeout(1500),
      });
      return res.ok;
    } catch {
      return false;
    }
  }

  async run(prompt: string): Promise<RunOutput> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: false,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama returned ${res.status}: ${await res.text()}`);
    }
    const data = (await res.json()) as {
      message?: { content?: string };
      prompt_eval_count?: number;
      eval_count?: number;
    };
    return {
      output: data.message?.content ?? "",
      model: this.model,
      usage: {
        inputTokens: data.prompt_eval_count,
        outputTokens: data.eval_count,
      },
    };
  }
}
