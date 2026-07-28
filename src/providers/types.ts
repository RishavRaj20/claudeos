// Core provider abstraction — every AI backend (Claude API, Ollama, a wrapped
// CLI agent) implements this interface. The scheduler only ever talks to it.

export interface RunOutput {
  output: string;
  model?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface Provider {
  /** Unique name from claudeos.config.json, e.g. "claude", "ollama" */
  name: string;
  /** "claude" | "ollama" | "cli" */
  kind: string;
  /** Cheap health check — is this backend reachable right now? */
  available(): Promise<boolean>;
  /** Execute one prompt and return the final text output. */
  run(prompt: string): Promise<RunOutput>;
}

export interface TaskRecord {
  id: string;
  prompt: string;
  provider: string;
  model?: string;
  output: string;
  startedAt: string;
  finishedAt: string;
  ok: boolean;
}
