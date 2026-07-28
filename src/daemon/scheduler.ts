import { randomUUID } from "node:crypto";
import type { ClaudeOSConfig } from "../config.ts";
import type { Provider, TaskRecord } from "../providers/types.ts";
import { RunStore } from "../memory/store.ts";
import { Vault } from "../memory/vault.ts";

// The scheduler is the "kernel" of ClaudeOS: it decides which provider
// (process) gets each task, executes it, and persists the result to shared
// memory (SQLite index + markdown vault).
export class Scheduler {
  private store = new RunStore();
  private vault = new Vault();
  private config: ClaudeOSConfig;
  private providers: Map<string, Provider>;

  constructor(config: ClaudeOSConfig, providers: Map<string, Provider>) {
    this.config = config;
    this.providers = providers;
  }

  pickProvider(prompt: string, explicit?: string): Provider {
    if (explicit) {
      const p = this.providers.get(explicit);
      if (!p) throw new Error(`Unknown provider "${explicit}"`);
      return p;
    }
    for (const rule of this.config.routing) {
      if (new RegExp(rule.match, "i").test(prompt)) {
        const p = this.providers.get(rule.provider);
        if (p) return p;
      }
    }
    const fallback = this.providers.get(this.config.defaultProvider);
    if (!fallback) throw new Error(`Default provider "${this.config.defaultProvider}" not configured`);
    return fallback;
  }

  /**
   * Memory injection: retrieve relevant past runs from the shared store and
   * prepend them to the prompt, so every agent — Claude, Ollama, or a wrapped
   * CLI — sees what other agents already did.
   */
  recall(prompt: string): Array<TaskRecord & { score: number }> {
    const mem = this.config.memory;
    if (mem && mem.inject === false) return [];
    return this.store.search(prompt, mem?.maxEntries ?? 3);
  }

  private buildPromptWithMemory(prompt: string): string {
    const entries = this.recall(prompt);
    if (entries.length === 0) return prompt;
    const maxChars = this.config.memory?.maxCharsPerEntry ?? 600;
    const lines = entries.map(
      (e) =>
        `- [${e.startedAt.slice(0, 16)} via ${e.provider}] task: ${e.prompt.slice(0, 200)}\n  result: ${e.output.slice(0, maxChars).replace(/\n+/g, " ")}`,
    );
    return [
      "<claudeos-memory>",
      "Context from ClaudeOS shared memory — prior work by you or other agents on this machine. Use it if relevant; ignore it if not.",
      ...lines,
      "</claudeos-memory>",
      "",
      prompt,
    ].join("\n");
  }

  async run(prompt: string, explicitProvider?: string): Promise<TaskRecord> {
    const provider = this.pickProvider(prompt, explicitProvider);
    const startedAt = new Date().toISOString();
    const id = randomUUID();
    let record: TaskRecord;
    try {
      const result = await provider.run(this.buildPromptWithMemory(prompt));
      record = {
        id,
        prompt,
        provider: provider.name,
        model: result.model,
        output: result.output,
        ok: true,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    } catch (err) {
      record = {
        id,
        prompt,
        provider: provider.name,
        output: `ERROR: ${err instanceof Error ? err.message : String(err)}`,
        ok: false,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
    this.store.insert(record);
    this.vault.writeRun(record);
    return record;
  }

  async providerStatus(): Promise<Record<string, { kind: string; available: boolean }>> {
    const entries = await Promise.all(
      [...this.providers.values()].map(async (p) => [
        p.name,
        { kind: p.kind, available: await p.available() },
      ] as const),
    );
    return Object.fromEntries(entries);
  }

  recentRuns(limit = 20): TaskRecord[] {
    return this.store.recent(limit);
  }

  runCount(): number {
    return this.store.count();
  }
}
