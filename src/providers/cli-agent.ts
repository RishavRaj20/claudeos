import { spawn } from "node:child_process";
import type { Provider, RunOutput } from "./types.ts";
import type { ProviderConfig } from "../config.ts";

// Wraps an existing CLI agent (Claude Code, Codex CLI, Gemini CLI, ...) as a
// ClaudeOS provider. The agent runs as a subprocess; "{prompt}" in the args
// template is replaced with the task prompt.
export class CliAgentProvider implements Provider {
  name: string;
  kind = "cli";
  private command: string;
  private argsTemplate: string[];
  private timeoutMs: number;

  constructor(name: string, cfg: ProviderConfig) {
    if (!cfg.command) throw new Error(`cli provider "${name}" needs a "command"`);
    this.name = name;
    this.command = cfg.command;
    this.argsTemplate = cfg.args ?? ["{prompt}"];
    this.timeoutMs = cfg.timeoutMs ?? 600_000;
  }

  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const check = spawn("which", [this.command]);
      check.on("close", (code) => resolve(code === 0));
      check.on("error", () => resolve(false));
    });
  }

  async run(prompt: string): Promise<RunOutput> {
    return this.runStream(prompt, () => {});
  }

  async runStream(prompt: string, onDelta: (text: string) => void): Promise<RunOutput> {
    const args = this.argsTemplate.map((a) => a.replaceAll("{prompt}", prompt));
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`${this.name} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);

      child.stdout.on("data", (d) => {
        stdout += d;
        onDelta(String(d));
      });
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve({ output: stdout.trim() });
        } else {
          reject(new Error(`${this.name} exited ${code}: ${stderr.slice(0, 2000)}`));
        }
      });
    });
  }
}
