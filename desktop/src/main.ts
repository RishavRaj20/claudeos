// ClaudeOS desktop dashboard — a thin client over the daemon's HTTP + WS API.
// The daemon (node src/cli.ts start) must be running on :7777.

const BASE = "http://localhost:7777";
const WS_URL = "ws://localhost:7777/ws";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const statusPill = $("daemon-status");
const providersEl = $("providers");
const mcpEl = $("mcp");
const pipelinesEl = $("pipelines");
const providerSelect = $<HTMLSelectElement>("provider");
const pipelineSelect = $<HTMLSelectElement>("pipeline-select");
const promptEl = $<HTMLTextAreaElement>("prompt");
const runBtn = $<HTMLButtonElement>("run");
const outputEl = $("output");
const runsEl = $("runs");
const feedEl = $("feed");

let online = false;
let pendingTaskId: string | null = null;

function esc(s: string): string {
  const div = document.createElement("div");
  div.textContent = s;
  return div.innerHTML;
}

// ---------- tabs ----------

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    document.querySelectorAll(".tab-page").forEach((p) => p.classList.add("hidden"));
    document.getElementById(`tab-${btn.dataset.tab}`)!.classList.remove("hidden");
    if (btn.dataset.tab === "memory") void loadMemoryList();
    if (btn.dataset.tab === "config") void loadConfig();
  });
});

// ---------- memory browser ----------

async function loadMemoryList(): Promise<void> {
  const listEl = $("memory-list");
  const res = await fetch(`${BASE}/memory`);
  const files = (await res.json()) as string[];
  listEl.innerHTML = "";
  for (const f of files) {
    const li = document.createElement("li");
    li.className = "clickable";
    li.textContent = f.replace(/\.md$/, "");
    li.addEventListener("click", async () => {
      listEl.querySelectorAll("li").forEach((x) => x.classList.remove("selected"));
      li.classList.add("selected");
      const r = await fetch(`${BASE}/memory/${encodeURIComponent(f)}`);
      const entry = (await r.json()) as { name: string; content: string };
      $("memory-title").textContent = entry.name;
      $("memory-content").textContent = entry.content;
    });
    listEl.appendChild(li);
  }
  if (files.length === 0) listEl.innerHTML = `<li class="dim">vault is empty</li>`;
}

// ---------- config editor ----------

const configEditor = $<HTMLTextAreaElement>("config-editor");
const configMsg = $("config-msg");

async function loadConfig(): Promise<void> {
  const res = await fetch(`${BASE}/config`);
  configEditor.value = JSON.stringify(await res.json(), null, 2);
  configMsg.textContent = "";
  configMsg.className = "dim";
}

$<HTMLButtonElement>("config-save").addEventListener("click", async () => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(configEditor.value);
  } catch (err) {
    configMsg.textContent = `invalid JSON: ${err instanceof Error ? err.message : err}`;
    configMsg.className = "err-mark";
    return;
  }
  const res = await fetch(`${BASE}/config`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(parsed),
  });
  const result = (await res.json()) as { ok?: boolean; note?: string; error?: string };
  configMsg.textContent = result.ok ? `✓ ${result.note}` : result.error ?? "save failed";
  configMsg.className = result.ok ? "ok-mark" : "err-mark";
});

// ---------- status / sidebar ----------

async function refresh(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/status`, { signal: AbortSignal.timeout(2000) });
    const status = await res.json();
    online = true;
    statusPill.textContent = `daemon: online · ${status.totalRuns} runs`;
    statusPill.className = "pill online";

    providersEl.innerHTML = "";
    const currentProvider = providerSelect.value;
    providerSelect.innerHTML = `<option value="">auto-route</option>`;
    for (const [name, p] of Object.entries(status.providers as Record<string, { kind: string; available: boolean }>)) {
      providersEl.insertAdjacentHTML(
        "beforeend",
        `<li><span class="dot ${p.available ? "on" : "off"}"></span>${esc(name)}<span class="meta">${esc(p.kind)}</span></li>`,
      );
      if (p.available) providerSelect.insertAdjacentHTML("beforeend", `<option>${esc(name)}</option>`);
    }
    providerSelect.value = currentProvider;

    mcpEl.innerHTML = "";
    for (const [name, s] of Object.entries((status.mcp ?? {}) as Record<string, { connected: boolean; tools: number }>)) {
      mcpEl.insertAdjacentHTML(
        "beforeend",
        `<li><span class="dot ${s.connected ? "on" : "off"}"></span>${esc(name)}<span class="meta">${s.tools} tools</span></li>`,
      );
    }
    if (!mcpEl.innerHTML) mcpEl.innerHTML = `<li class="dim">none configured</li>`;

    const pres = await fetch(`${BASE}/pipelines`);
    const pipelines = (await pres.json()) as Record<string, string[]>;
    pipelinesEl.innerHTML = "";
    const currentPipeline = pipelineSelect.value;
    pipelineSelect.innerHTML = `<option value="">no pipeline</option>`;
    for (const [name, steps] of Object.entries(pipelines)) {
      pipelinesEl.insertAdjacentHTML("beforeend", `<li>${esc(name)}<span class="meta">${steps.length} steps</span></li>`);
      pipelineSelect.insertAdjacentHTML("beforeend", `<option>${esc(name)}</option>`);
    }
    if (!pipelinesEl.innerHTML) pipelinesEl.innerHTML = `<li class="dim">none defined</li>`;
    pipelineSelect.value = currentPipeline;

    await refreshRuns();
  } catch {
    online = false;
    statusPill.textContent = "daemon: offline — run `claudeos start`";
    statusPill.className = "pill offline";
  }
}

async function refreshRuns(): Promise<void> {
  const res = await fetch(`${BASE}/runs`);
  const runs = (await res.json()) as Array<{ provider: string; ok: boolean; prompt: string; startedAt: string }>;
  runsEl.innerHTML = "";
  for (const r of runs.slice(0, 12)) {
    runsEl.insertAdjacentHTML(
      "beforeend",
      `<li><span class="${r.ok ? "ok-mark" : "err-mark"}">${r.ok ? "✓" : "✗"}</span>
       <span class="tag">${esc(r.provider)}</span> ${esc(r.prompt.slice(0, 64))}</li>`,
    );
  }
}

// ---------- run ----------

async function run(): Promise<void> {
  const prompt = promptEl.value.trim();
  if (!prompt || !online) return;
  runBtn.disabled = true;
  outputEl.innerHTML = `<span class="dim">running…</span>`;
  try {
    if (pipelineSelect.value) {
      const res = await fetch(`${BASE}/pipelines/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: pipelineSelect.value, input: prompt }),
      });
      const result = (await res.json()) as {
        error?: string;
        ok?: boolean;
        steps?: Array<{ step: string; record: { provider: string; ok: boolean; output: string } }>;
      };
      if (result.error) throw new Error(result.error);
      outputEl.innerHTML = (result.steps ?? [])
        .map(
          (s) =>
            `<div class="step-head">── ${esc(s.step)} [${esc(s.record.provider)}] ${s.record.ok ? "✓" : "✗"}</div>${esc(s.record.output)}\n`,
        )
        .join("\n");
      runBtn.disabled = false;
    } else {
      // Async submit — WS task.finished event fills the output live.
      const res = await fetch(`${BASE}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, provider: providerSelect.value || undefined }),
      });
      const task = (await res.json()) as { taskId?: string; error?: string };
      if (task.error || !task.taskId) throw new Error(task.error ?? "submit failed");
      pendingTaskId = task.taskId;
      streamedChars = 0;
      outputEl.innerHTML = `<span class="spinner">⏳ running task ${esc(task.taskId.slice(0, 8))}…</span>`;
    }
  } catch (err) {
    outputEl.innerHTML = `<span class="err-mark">${esc(err instanceof Error ? err.message : String(err))}</span>`;
    runBtn.disabled = false;
  } finally {
    void refreshRuns();
  }
}

let streamedChars = 0;

function onTaskDelta(taskId: string, text: string): void {
  if (taskId !== pendingTaskId) return;
  if (streamedChars === 0) {
    // First token: replace the spinner with a live stream container.
    outputEl.innerHTML = `<div class="step-head">streaming…</div><span id="stream-text"></span><span class="spinner">▌</span>`;
  }
  streamedChars += text.length;
  const streamText = document.getElementById("stream-text");
  if (streamText) streamText.textContent += text;
  outputEl.scrollTop = outputEl.scrollHeight;
}

function onTaskFinished(task: {
  taskId: string;
  record?: { provider: string; model?: string; ok: boolean; output: string };
}): void {
  if (task.taskId !== pendingTaskId || !task.record) return;
  pendingTaskId = null;
  streamedChars = 0;
  runBtn.disabled = false;
  const r = task.record;
  outputEl.innerHTML = `<div class="step-head">[${esc(r.provider)}${r.model ? ` / ${esc(r.model)}` : ""}] ${r.ok ? "✓" : "✗"}</div>${esc(r.output)}`;
  void refreshRuns();
}

runBtn.addEventListener("click", () => void run());
promptEl.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void run();
});

// ---------- live event feed (WebSocket) ----------

function feedLine(html: string, cls = ""): void {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.innerHTML = html;
  feedEl.prepend(li);
  while (feedEl.children.length > 200) feedEl.lastChild?.remove();
}

function connectWs(): void {
  const ws = new WebSocket(WS_URL);
  ws.addEventListener("open", () => feedLine(`<b>connected</b> to event bus`));
  ws.addEventListener("message", (msg) => {
    try {
      const e = JSON.parse(String(msg.data));
      if (e.type === "task.delta") {
        onTaskDelta(e.taskId, e.text);
        return; // token stream — not shown in the event feed
      }
      if (e.task) {
        const ok = e.task.record ? (e.task.record.ok ? "ok" : "err") : "";
        feedLine(`<b>${esc(e.type)}</b> ${esc(e.task.prompt?.slice(0, 48) ?? "")}`, ok);
        if (e.type === "task.finished") onTaskFinished(e.task);
      } else if (e.type?.startsWith("pipeline.")) {
        const ok = e.ok === undefined ? "" : e.ok ? "ok" : "err";
        feedLine(`<b>${esc(e.type)}</b> ${esc(e.name ?? "")}${e.step ? ` · ${esc(e.step)}` : ""}${e.provider ? ` [${esc(e.provider)}]` : ""}`, ok);
      } else {
        feedLine(esc(JSON.stringify(e)));
      }
    } catch {
      /* ignore malformed */
    }
  });
  ws.addEventListener("close", () => {
    feedLine(`<b>disconnected</b> — retrying in 3s`, "err");
    setTimeout(connectWs, 3000);
  });
  ws.addEventListener("error", () => ws.close());
}

// ---------- boot ----------

void refresh();
setInterval(() => void refresh(), 5000);
connectWs();
