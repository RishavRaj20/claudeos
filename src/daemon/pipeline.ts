import { randomUUID } from "node:crypto";
import type { ClaudeOSConfig, PipelineStep } from "../config.ts";
import type { Scheduler } from "./scheduler.ts";
import type { TaskRecord } from "../providers/types.ts";

// Multi-step pipelines: research → implement → verify chains where each step
// can run on a different provider and consumes prior steps' output via prompt
// templates: {input} = pipeline input, {prev} = previous step's output,
// {<stepname>} = a named earlier step's output.

export interface PipelineStepResult {
  step: string;
  record: TaskRecord;
}

export interface PipelineResult {
  pipelineId: string;
  name: string;
  input: string;
  ok: boolean;
  steps: PipelineStepResult[];
  output: string; // last step's output
  startedAt: string;
  finishedAt: string;
}

export type PipelineEmit = (event: {
  type: "pipeline.started" | "pipeline.step.started" | "pipeline.step.finished" | "pipeline.finished";
  pipelineId: string;
  name: string;
  step?: string;
  provider?: string;
  ok?: boolean;
}) => void;

function renderTemplate(
  template: string,
  input: string,
  outputs: Map<string, string>,
  prev: string,
): string {
  let out = template.replaceAll("{input}", input).replaceAll("{prev}", prev);
  for (const [step, value] of outputs) {
    out = out.replaceAll(`{${step}}`, value);
  }
  return out;
}

export async function runPipeline(
  scheduler: Scheduler,
  config: ClaudeOSConfig,
  name: string,
  input: string,
  emit: PipelineEmit = () => {},
): Promise<PipelineResult> {
  const steps: PipelineStep[] | undefined = config.pipelines?.[name];
  if (!steps || steps.length === 0) {
    const known = Object.keys(config.pipelines ?? {}).join(", ") || "(none defined)";
    throw new Error(`Unknown pipeline "${name}". Available: ${known}`);
  }

  const pipelineId = randomUUID();
  const startedAt = new Date().toISOString();
  const outputs = new Map<string, string>();
  const results: PipelineStepResult[] = [];
  let prev = "";
  let ok = true;

  emit({ type: "pipeline.started", pipelineId, name });

  for (const step of steps) {
    const prompt = renderTemplate(step.prompt, input, outputs, prev);
    emit({ type: "pipeline.step.started", pipelineId, name, step: step.name, provider: step.provider });
    const record = await scheduler.run(prompt, step.provider);
    results.push({ step: step.name, record });
    emit({
      type: "pipeline.step.finished",
      pipelineId,
      name,
      step: step.name,
      provider: record.provider,
      ok: record.ok,
    });
    if (!record.ok) {
      ok = false;
      break; // a failed step aborts the chain
    }
    outputs.set(step.name, record.output);
    prev = record.output;
  }

  emit({ type: "pipeline.finished", pipelineId, name, ok });

  return {
    pipelineId,
    name,
    input,
    ok,
    steps: results,
    output: prev,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
}
