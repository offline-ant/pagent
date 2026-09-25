import { setTimeout as delay } from "node:timers/promises";
import { createEngineFactory } from "./agent.ts";
import { agentConsoleEntries } from "./agent-console.ts";
import { DiagnosticBuffer } from "./diagnostics.ts";
import { EventJournal } from "./journal.ts";
import { nativeRequest } from "./native-request.ts";
import { SessionAgents, type EventScope } from "./session-agents.ts";
import { type Workspace } from "./storage.ts";
import type { AgentDescriptor, AgentEngine, AgentEvent, BrowserKind, BrowserLog, BrowserPageOptions, NativeRequest, PageBrowser, PageContext, HostEvent } from "./protocol.ts";
import { TOOL_NAMES, toolNames, effectiveTools, type CheckpointPolicy, type ExecutionState } from "./agent-config.ts";
import { Execution } from "./execution.ts";
import type { WebBackendState } from "pi-browser/web";

export interface PagentSession {
  url: string;
  directory: string;
  stateDirectory: string;
  browser: PageBrowser;
  readonly agents: ReadonlyMap<string, AgentEngine>;
  readonly modelLabel: string;
  readonly busy: boolean;
  readonly executionState: ExecutionState;
  start(): Promise<void>;
  stop(): Promise<void>;
  getBackendState(): WebBackendState;
  save(): Promise<string>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

export interface SessionOptions {
  workspace: Workspace;
  url: string;
  browserKind: BrowserKind;
  model?: string;
  thinking?: string;
  fake?: boolean;
  webHeadless?: boolean;
  tools?: string[];
  http?: string[];
  network?: "open" | "local";
  checkpoint?: CheckpointPolicy;
  durationMs?: number;
  repeatDelayMs?: number;
  onExecutionStart?: () => Promise<void>;
  onExecutionStop?: () => Promise<void>;
  /** Live acknowledgments only, not reconnect replay; must not block delivery/inference. */
  onRecordingEvent?: (record: HostEvent) => void;
  onRecordingInvalidated?: () => void;
  signal?: AbortSignal;
  log: (message: string) => void;
  onConsole?: (entry: BrowserLog) => void;
  createBrowser: (options: BrowserPageOptions) => Promise<PageBrowser>;
  onClose: () => void;
}

/** One page owns multiple inference identities, one replay stream, and ordered checkpoints. */
export async function startSession(options: SessionOptions): Promise<PagentSession> {
  const { workspace, log } = options;
  const checkpoint = options.checkpoint ?? "document";
  const tools = effectiveTools({}, options.tools === undefined ? [...TOOL_NAMES] : toolNames(options.tools), options.network ?? "open", checkpoint);
  // Private/disabled checkpoints deliberately restart from the original HTML.
  // Their delivery stream must not replay a previous world's conversation.
  const journal = new EventJournal(checkpoint === "document" ? workspace.stateDirectory : undefined);
  const diagnostics = new DiagnosticBuffer();
  let browser: PageBrowser | undefined;
  let agents: SessionAgents | undefined;
  let closed = false;
  let stopping = false;
  let closePromise: Promise<void> | undefined;
  let reloading = false;
  let pageReady = false;
  let runtimeEpoch = 0;
  let lastDelivered = 0;
  let delivery: Promise<void> = Promise.resolve();
  let pageOperations: Promise<unknown> = Promise.resolve();
  const startupRequests: unknown[] = [];
  let accepting = false;
  const cleanupDeadline = new AbortController();
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  const connection = Promise.withResolvers<void>();
  const firstConnection = connection.promise;
  // Registration can fail before startup reaches its first await of this promise.
  void firstConnection.catch(() => {});
  const execution = new Execution({
    durationMs: options.durationMs, repeatDelayMs: options.repeatDelayMs,
    participants: () => agents?.participants ?? [],
    prompt: async (id, text, scheduleId, current) => {
      await flush();
      if (!current() || stopping || !agents?.idle(id) || !browser) return;
      const result = await browser.evaluateValue(`(() => {
        const agent = document.getElementById(${JSON.stringify(id)});
        if (!agent || !agent.canSubmit) return false;
        agent.prompt(${JSON.stringify(text)}, ${JSON.stringify(scheduleId)});
        return true;
      })()`);
      if (current() && result !== true) throw new Error("Agent element is absent or unavailable.");
    },
    flush, cancel: async () => { await beforeCleanupDeadline(agents?.cancelAll() ?? Promise.resolve()); },
    changed: state => { emit({ type: "execution-state", state }); },
    onStart: options.onExecutionStart,
    onStop: async () => {
      // All terminal paths share this one budget, starting before capture or
      // cancellation. A stalled provider cannot keep the browser/recorder alive.
      options.onRecordingInvalidated?.();
      browser?.prepareToStop?.();
      cleanupTimer = setTimeout(() => {
        log("Cleanup deadline reached; closing the owned browser.");
        cleanupDeadline.abort();
        void browser?.close().catch(error => log(String(error)));
        void close().catch(error => log(String(error)));
      }, 6_000);
      await beforeCleanupDeadline(options.onExecutionStop?.() ?? Promise.resolve());
    }, log,
  });

  function beforeCleanupDeadline(operation: Promise<unknown>): Promise<void> {
    return new Promise((resolve, reject) => {
      const expired = () => resolve();
      if (cleanupDeadline.signal.aborted) resolve();
      else cleanupDeadline.signal.addEventListener("abort", expired, { once: true });
      void operation.then(() => resolve(), reject).finally(() => cleanupDeadline.signal.removeEventListener("abort", expired));
    });
  }

  function emit(event: AgentEvent, scope: EventScope = {}): void {
    if (closed || cleanupDeadline.signal.aborted) return;
    const epoch = runtimeEpoch;
    const record = journal.append(event, scope);
    const reportUndelivered = () => {
      for (const entry of agentConsoleEntries(record)) options.onConsole?.({
        source: "console", synthetic: true, level: entry.level, text: `[pending page delivery] ${entry.text}`,
      });
    };
    delivery = delivery.then(async () => {
      if (!browser || !pageReady) { reportUndelivered(); return; }
      if (record.seq <= lastDelivered) return; // Already consumed by the ordered reconnect drain.
      await browser.deliver(record);
      lastDelivered = Math.max(lastDelivered, record.seq);
      if (epoch === runtimeEpoch && !closed && !stopping && !reloading && execution.state !== "stopped") {
        try { options.onRecordingEvent?.(record); }
        catch (error) { log(`Recording event failed: ${String(error)}`); }
      }
    }).catch(error => {
      pageReady = false;
      reportUndelivered();
      log(`Page delivery paused: ${String(error)}. Events remain in the outbox; repair the page or reload a checkpoint.`);
    });
  }

  function workspaceState(): void {
    emit({ type: "workspace-state", busy: agents?.busy ?? false, reloading });
  }

  async function flush(): Promise<void> {
    for (;;) {
      const pending = delivery;
      await pending;
      if (pending === delivery) break;
    }
    if (!pageReady) throw new Error("Page input/output is disconnected. Reload or repair the page; pending output is retained.");
  }

  function pageOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = pageOperations.then(operation);
    pageOperations = result.catch(() => {});
    return result;
  }

  function save(): Promise<string> {
    return pageOperation(async () => {
      if (closed || cleanupDeadline.signal.aborted) throw new Error("Pagent is closed.");
      await flush();
      if (closed || cleanupDeadline.signal.aborted) throw new Error("Pagent is closed.");
      if (checkpoint === "none") { journal.checkpoint(lastDelivered); return "disabled"; }
      if (!browser) throw new Error("Browser is not running.");
      const epoch = runtimeEpoch;
      const cursor = lastDelivered;
      const html = await browser.snapshot();
      if (closed || cleanupDeadline.signal.aborted) throw new Error("Pagent is closed.");
      if (epoch !== runtimeEpoch || !pageReady) throw new Error("Runtime changed while saving; queued output was retained. Retry after reconnection.");
      const revision = checkpoint === "private" ? await workspace.checkpointPrivate(html) : await workspace.checkpoint(html);
      if (epoch !== runtimeEpoch || !pageReady) throw new Error("Runtime changed while checkpointing; queued output was retained. Retry after reconnection.");
      journal.checkpoint(cursor);
      emit({ type: "saved", revision });
      return revision;
    });
  }

  async function readContext(agentId: string, inputId?: string): Promise<PageContext> {
    await flush();
    if (!browser) throw new Error("Browser is not running.");
    const epoch = runtimeEpoch;
    const args = [agentId, ...(inputId === undefined ? [] : [inputId])].map(value => JSON.stringify(value)).join(",");
    const json = await browser.evaluateValue(`(async () => JSON.stringify(await window.pagent.collectContext(${args})))()`);
    if (epoch !== runtimeEpoch || !pageReady) throw new Error("Runtime changed during context collection; submit again after reconnection.");
    if (typeof json !== "string") throw new Error("pagent.collectContext() did not return JSON-serializable context.");
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || !("memory" in value) || typeof value.memory !== "string" || !("outline" in value) || typeof value.outline !== "string" || !("history" in value) || !Array.isArray(value.history)) {
      throw new Error("pagent.collectContext() must return {memory:string, outline:string, history:Message[], prompt?:string}.");
    }
    return { memory: value.memory, outline: value.outline, history: value.history,
      ...("prompt" in value && typeof value.prompt === "string" ? { prompt: value.prompt } : {}) };
  }

  function reconnect(after: number, descriptors: AgentDescriptor[]): void {
    if (stopping || execution.state === "stopped") throw new Error("Execution has stopped.");
    const ids = descriptors.map(agent => agent.agentId);
    journal.observeCursor(after);
    pageReady = false;
    const epoch = runtimeEpoch;
    const pool = agents!;
    // Retire absent identities before admitting restored ones, including at the
    // attached-agent limit. Never await their checkpoints on the delivery queue.
    for (const id of pool.ids) if (!ids.includes(id)) { execution.remove(id); void pool.dispose(id).catch(error => log(String(error))); }
    const available: string[] = [];
    for (const { agentId: id, ...configuration } of descriptors) {
      const disposing = pool.disposal(id);
      if (!disposing) { pool.register(id, configuration); available.push(id); continue; }
      // A saved element may reappear while its previous incarnation is closing.
      // Reconnect the page first: disposal may be awaiting a checkpoint queued
      // behind this navigation. Its replacement connects after disposal settles.
      void disposing.then(async () => {
        if (runtimeEpoch !== epoch || stopping || closed) return;
        const events = await pool.connectionEvents(id, options.url, configuration);
        if (runtimeEpoch === epoch) for (const { event, scope } of events) emit(event, scope);
      }).catch(error => log(`Restored agent ${id} could not connect: ${String(error)}`));
    }
    delivery = delivery.then(async () => {
      if (!browser) return;
      // Snapshots join the journal before draining. Never deliver a new connected
      // record ahead of output appended by a sibling while these awaits run.
      for (const id of available) {
        for (const { event, scope } of await pool.connectionEvents(id, options.url)) journal.append(event, scope);
      }
      journal.append({ type: "workspace-state", busy: pool.busy, reloading });
      journal.append({ type: "execution-state", state: execution.state });
      let cursor = after;
      lastDelivered = after;
      for (;;) {
        if (runtimeEpoch !== epoch) throw new Error("Runtime changed while reconnecting; wait for the new page's ready request.");
        const pending = journal.after(cursor);
        if (!pending.length) break;
        for (const record of pending) {
          await browser.deliver(record);
          if (runtimeEpoch !== epoch) throw new Error("Runtime changed during replay; output remains in the outbox.");
          cursor = record.seq;
          lastDelivered = record.seq;
        }
      }
      pageReady = true;
      connection.resolve();
    }).catch(error => { connection.reject(error); log(`Page reconnect failed: ${String(error)}`); });
  }

  async function handle(request: NativeRequest): Promise<void> {
    if (!agents || !browser) throw new Error("Pagent is still starting.");
    if (request.type === "ready") { reconnect(request.after, request.agents); return; }
    if (request.type === "cancel") { execution.pause(request.agentId); await agents.cancel(request.agentId); return; }
    if (request.type === "dispose") {
      execution.remove(request.agentId);
      await agents.dispose(request.agentId);
      emit({ type: "disposed" }, { agentId: request.agentId });
      return;
    }
    if (request.type === "web-continue" || request.type === "web-cancel") {
      await agents.respond(request.agentId, request.id, request.type === "web-continue");
      return;
    }
    if (request.type === "stop") { await execution.stop(); return; }
    if (stopping) throw new Error("Pagent is shutting down.");
    if (request.type === "submit") {
      if (request.scheduleId !== undefined && !execution.accept(request.agentId, request.scheduleId)) {
        agents.rejectScheduled(request.agentId, request.id, request.runId);
        return;
      }
      execution.pause(request.agentId);
      await agents.submit(request.agentId, request.id, request.runId);
      return;
    }
    if (execution.state === "stopped") throw new Error("Execution has stopped.");
    if (request.type === "start") { await execution.start(); return; }
    if (request.type === "nudge") { await execution.nudge(); return; }
    if (request.type === "register") {
      const { type: _type, agentId, ...configuration } = request;
      for (const { event, scope } of await agents.connectionEvents(agentId, options.url, configuration)) emit(event, scope);
      return;
    }
    if (request.type === "backend-set") {
      if (!tools.some(name => name.startsWith("web_"))) throw new Error("Web research is disabled by host policy.");
      await agents.setBackendOverride(request.override); return;
    }
    if (request.type === "save") {
      if (!tools.includes("save")) throw new Error("Save is disabled by host policy.");
      await save(); return;
    }
    if (request.type === "reload") {
      if (!tools.includes("reload")) throw new Error("Reload is disabled by host policy.");
      if (reloading) throw new Error("Workspace is already reloading.");
      reloading = true;
      options.onRecordingInvalidated?.();
      workspaceState();
      try { await agents.cancelAll(); await navigate(); }
      finally { reloading = false; workspaceState(); }
      return;
    }
  }

  function navigate(): Promise<void> {
    return pageOperation(async () => {
      await delivery;
      runtimeEpoch++;
      pageReady = false;
      if (checkpoint !== "document") journal.discard();
      await nativeBrowserReference!.reload();
      const deadline = Date.now() + 10_000;
      while (!pageReady && Date.now() < deadline) { await delivery; await delay(10); }
      await flush();
    });
  }
  let nativeBrowserReference: PageBrowser | undefined;

  function receive(value: unknown): void {
    if (closed) return;
    if (!accepting) { if (startupRequests.length < 100) startupRequests.push(value); return; }
    let request: NativeRequest;
    try { request = nativeRequest(value); }
    catch (error) {
      if (value && typeof value === "object" && "type" in value && value.type === "ready") connection.reject(error);
      emit({ type: "error", message: String(error) }); return;
    }
    void handle(request).catch(error => {
      if (request.type === "ready") connection.reject(error);
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) },
        "agentId" in request ? { agentId: request.agentId } : {});
    });
  }

  async function cleanup(checkpoint: boolean): Promise<void> {
    stopping = true;
    options.onRecordingInvalidated?.();
    const errors: unknown[] = [];
    const attempt = async (operation: () => unknown) => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => execution.stop());
    if (checkpoint && pageReady && browser && !cleanupDeadline.signal.aborted) {
      try { await beforeCleanupDeadline(save().then(() => flush())); } catch (error) { log(`Shutdown checkpoint failed: ${String(error)}`); }
    }
    closed = true;
    await beforeCleanupDeadline(pageOperations);
    await attempt(() => beforeCleanupDeadline(agents?.close() ?? Promise.resolve()));
    clearTimeout(cleanupTimer);
    options.onClose();
    if (errors.length) throw new AggregateError(errors, "Pagent session cleanup failed");
  }

  function close(): Promise<void> { closePromise ??= cleanup(true); return closePromise; }

  try {
    options.signal?.throwIfAborted();
    const factory = await createEngineFactory({ model: options.model, thinking: options.thinking, fake: options.fake });
    const nativeBrowser = await options.createBrowser({
      url: options.url, onRequest: receive,
      onConsole: entry => { diagnostics.append(entry); options.onConsole?.(entry); },
      onRuntimeReset: () => {
        options.onRecordingInvalidated?.();
        runtimeEpoch++; pageReady = false;
        if (checkpoint !== "document") journal.discard();
        if (execution.state === "running") void execution.stop().catch(error => log(String(error)));
      },
      onError: error => { log(error.message); },
      onClose: () => {
        options.onRecordingInvalidated?.();
        pageReady = false;
        stopping = true;
        if (accepting) void close().catch(error => log(String(error)));
      },
    });
    nativeBrowserReference = nativeBrowser;
    browser = {
      evaluate: (code, settings) => nativeBrowser.evaluate(code, settings),
      evaluateValue: expression => nativeBrowser.evaluateValue(expression),
      snapshot: () => nativeBrowser.snapshot(), screenshot: () => nativeBrowser.screenshot(),
      ...(nativeBrowser.captureFrame ? { captureFrame: (settings: { screenshot: boolean }) => nativeBrowser.captureFrame!(settings) } : {}),
      prepareToStop: () => nativeBrowser.prepareToStop?.(),
      deliver: event => nativeBrowser.deliver(event), close: () => nativeBrowser.close(),
      async reload() {
        if (reloading) throw new Error("Workspace is already reloading.");
        reloading = true;
        options.onRecordingInvalidated?.();
        workspaceState();
        try { await navigate(); }
        finally { reloading = false; workspaceState(); }
      },
    };
    options.signal?.throwIfAborted();
    if (stopping) throw new Error("Workspace tab was closed during startup.");
    agents = await SessionAgents.create({ factory, directory: workspace.directory, stateDirectory: workspace.stateDirectory,
      browserKind: options.browserKind, browser, readContext, save, diagnostics: () => diagnostics.snapshot(),
      webHeadless: options.webHeadless, tools, http: options.http, network: options.network, checkpoint,
      readResource: resource => workspace.read(resource), completed: run => execution.completed(run),
      emit, log, changed: workspaceState, blocked: () => stopping || reloading || execution.blocked });
    options.signal?.throwIfAborted();
    accepting = true;
    for (const request of startupRequests.splice(0)) receive(request);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([firstConnection, new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("The page did not connect. Its UI scripts must install the p-agent event receiver and send {type:'ready',after,agents}. Repair the scripts or use --reset-ui to back up and replace the starter UI.")), 10_000);
      })]);
    } finally { clearTimeout(timer); }
    options.signal?.throwIfAborted();
    if (stopping) throw new Error("Workspace tab was closed during startup.");
    return { url: options.url, directory: workspace.directory, stateDirectory: workspace.stateDirectory, browser,
      agents: agents.engines, modelLabel: agents.modelLabel, get busy() { return agents!.busy; },
      get executionState() { return execution.state; }, start: () => execution.start(), stop: () => execution.stop(),
      getBackendState: () => agents!.getBackendState(), save, flush, close };
  } catch (error) {
    closePromise ??= cleanup(false);
    await closePromise.catch(failure => log(String(failure)));
    throw error;
  }
}
