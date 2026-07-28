import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskRecord } from "../providers/types.ts";

// SQLite index of every task run — the queryable half of ClaudeOS memory.
// Lives in ~/.claudeos so it's shared regardless of where the repo sits.
const DATA_DIR = join(homedir(), ".claudeos");

export class RunStore {
  private db: DatabaseSync;

  constructor() {
    mkdirSync(DATA_DIR, { recursive: true });
    this.db = new DatabaseSync(join(DATA_DIR, "claudeos.db"));
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY,
        prompt TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT,
        output TEXT NOT NULL,
        ok INTEGER NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT NOT NULL
      );
    `);
  }

  insert(r: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO runs (id, prompt, provider, model, output, ok, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.id, r.prompt, r.provider, r.model ?? null, r.output, r.ok ? 1 : 0, r.startedAt, r.finishedAt);
  }

  recent(limit = 20): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT * FROM runs ORDER BY started_at DESC LIMIT ?`)
      .all(limit) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: String(row.id),
      prompt: String(row.prompt),
      provider: String(row.provider),
      model: row.model ? String(row.model) : undefined,
      output: String(row.output),
      ok: Boolean(row.ok),
      startedAt: String(row.started_at),
      finishedAt: String(row.finished_at),
    }));
  }

  /**
   * Keyword-relevance search over past successful runs. Scores word overlap
   * between the query and each run's prompt/output, with a recency boost.
   * Deliberately simple for phase 1 — swap for embeddings later.
   */
  search(query: string, limit = 3): Array<TaskRecord & { score: number }> {
    const words = [
      ...new Set(
        query
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter((w) => w.length > 3),
      ),
    ];
    if (words.length === 0) return [];
    const candidates = this.recent(200).filter((r) => r.ok);
    const scored = candidates.map((r, idx) => {
      const promptLc = r.prompt.toLowerCase();
      const outputLc = r.output.toLowerCase();
      let score = 0;
      for (const w of words) {
        if (promptLc.includes(w)) score += 2;
        if (outputLc.includes(w)) score += 1;
      }
      score += Math.max(0, (candidates.length - idx) / candidates.length); // recency boost
      return { ...r, score };
    });
    return scored
      .filter((r) => r.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  count(): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM runs`).get() as { n: number };
    return row.n;
  }
}

export const DATA_DIR_PATH = DATA_DIR;
