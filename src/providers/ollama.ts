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
    return this.runStream(prompt, () => {});
  }

  async runStream(prompt: string, onDelta: (text: string) => void): Promise<RunOutput> {
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        stream: true,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!res.ok || !res.body) {
      throw new Error(`ollama returned ${res.status}: ${await res.text()}`);
    }
    // NDJSON stream: one JSON object per line, tokens in message.content
    let output = "";
    let usage: RunOutput["usage"] = {};
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const data = JSON.parse(line) as {
          message?: { content?: string };
          done?: boolean;
          prompt_eval_count?: number;
          eval_count?: number;
        };
        const token = data.message?.content ?? "";
        if (token) {
          output += token;
          onDelta(token);
        }
        if (data.done) {
          usage = { inputTokens: data.prompt_eval_count, outputTokens: data.eval_count };
        }
      }
    }
    return { output, model: this.model, usage };
  }
}
