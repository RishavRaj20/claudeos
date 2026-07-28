import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { Scheduler } from "./scheduler.ts";
import type { TaskRecord } from "../providers/types.ts";

// Async task manager: fire-and-forget task execution with observable
// lifecycle events. The WebSocket endpoint broadcasts these events so any
// client (CLI `watch`, phase-2 UI) can follow tasks in real time.

export type TaskStatus = "queued" | "running" | "done" | "failed";

export interface AsyncTask {
  taskId: string;
  prompt: string;
  provider?: string;
  status: TaskStatus;
  createdAt: string;
  record?: TaskRecord;
}

export interface TaskEvent {
  type: "task.queued" | "task.started" | "task.finished";
  task: AsyncTask;
}

export interface TaskDeltaEvent {
  type: "task.delta";
  taskId: string;
  text: string;
}

export class TaskManager extends EventEmitter {
  private tasks = new Map<string, AsyncTask>();
  private scheduler: Scheduler;

  constructor(scheduler: Scheduler) {
    super();
    this.scheduler = scheduler;
  }

  submit(prompt: string, provider?: string): AsyncTask {
    const task: AsyncTask = {
      taskId: randomUUID(),
      prompt,
      provider,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    this.tasks.set(task.taskId, task);
    this.emit("event", { type: "task.queued", task } satisfies TaskEvent);

    // Execute without blocking the HTTP response.
    queueMicrotask(async () => {
      task.status = "running";
      this.emit("event", { type: "task.started", task } satisfies TaskEvent);
      const record = await this.scheduler.run(prompt, provider, (text) => {
        this.emit("event", { type: "task.delta", taskId: task.taskId, text } satisfies TaskDeltaEvent);
      });
      task.record = record;
      task.status = record.ok ? "done" : "failed";
      this.emit("event", { type: "task.finished", task } satisfies TaskEvent);
    });

    return task;
  }

  get(taskId: string): AsyncTask | undefined {
    return this.tasks.get(taskId);
  }

  list(): AsyncTask[] {
    return [...this.tasks.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
}
