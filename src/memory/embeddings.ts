// Local embeddings via Ollama — no API key, fully private. Used to upgrade
// memory recall from keyword matching to semantic similarity. Degrades
// gracefully: if Ollama (or the embed model) is unavailable, recall falls
// back to keyword search.

export interface EmbeddingsConfig {
  baseUrl?: string;
  model?: string;
}

export class Embedder {
  private baseUrl: string;
  readonly model: string;

  constructor(cfg: EmbeddingsConfig = {}) {
    this.baseUrl = cfg.baseUrl ?? "http://localhost:11434";
    this.model = cfg.model ?? "nomic-embed-text";
  }

  async available(): Promise<boolean> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return false;
      const data = (await res.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? []).some((m) => m.name.startsWith(this.model));
    } catch {
      return false;
    }
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/api/embed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) throw new Error(`embed failed: ${res.status} ${await res.text()}`);
    const data = (await res.json()) as { embeddings: number[][] };
    return data.embeddings.map((e) => Float32Array.from(e));
  }
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}
