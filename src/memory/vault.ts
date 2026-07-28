import { mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskRecord } from "../providers/types.ts";

// Markdown vault — the human-readable half of ClaudeOS memory. One file per
// task run, greppable and Obsidian-compatible. All agents share this space,
// so a task started by Claude can be continued by a local Ollama model.
const VAULT_DIR = join(homedir(), ".claudeos", "memory");

export class Vault {
  constructor() {
    mkdirSync(VAULT_DIR, { recursive: true });
  }

  writeRun(r: TaskRecord): string {
    const slug = r.prompt
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48);
    const file = join(VAULT_DIR, `${r.startedAt.replace(/[:.]/g, "-")}-${slug || "task"}.md`);
    const body = [
      "---",
      `id: ${r.id}`,
      `provider: ${r.provider}`,
      r.model ? `model: ${r.model}` : null,
      `started: ${r.startedAt}`,
      `finished: ${r.finishedAt}`,
      `ok: ${r.ok}`,
      "---",
      "",
      `## Prompt`,
      "",
      r.prompt,
      "",
      `## Output`,
      "",
      r.output,
      "",
    ]
      .filter((l) => l !== null)
      .join("\n");
    writeFileSync(file, body);
    return file;
  }

  list(limit = 20): string[] {
    return readdirSync(VAULT_DIR)
      .filter((f) => f.endsWith(".md"))
      .sort()
      .reverse()
      .slice(0, limit);
  }

  read(filename: string): string {
    return readFileSync(join(VAULT_DIR, filename), "utf-8");
  }
}

export const VAULT_DIR_PATH = VAULT_DIR;
