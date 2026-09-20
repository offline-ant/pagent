import { setTimeout as delay } from "node:timers/promises";
import { createEngineFactory } from "./agent.ts";
import { agentConsoleEntries } from "./agent-console.ts";
import { DiagnosticBuffer } from "./diagnostics.ts";
import { EventJournal } from "./journal.ts";
import { nativeRequest } from "./native-request.ts";
import { SessionAgents, type EventScope } from "./session-agents.ts";
import { type Workspace } from "./storage.ts";
import type { AgentEngine, AgentEvent, BrowserKind, BrowserLog, BrowserPageOptions, NativeRequest, PageBrowser, PageContext } from "./protocol.ts";
import type { WebBackendState } from "pi-browser/web";

export interface PagentSession {
  url: string;
  directory: string;
  stateDirectory: string;
  browser: PageBrowser;
  readonly agents: ReadonlyMap<string, AgentEngine>;
  readonly modelLabel: string;
  readonly busy: boolean;
  getBackendState(): WebBackendState;
  save(): Promise<string>;
  flush(): Promise<void>;
  close(): Promise<void>;
}

interface SessionOptions {
  workspace: Workspace;
  url: string;
  browserKind: BrowserKind;
  model?: string;
  thinking?: string;
  fake?: boolean;
  webHeadless?: boolean;
  signal?: AbortSignal;
  log: (message: string) => void;
  onConsole?: (entry: BrowserLog) => void;
  createBrowser: (options: BrowserPageOptions) => Promise<PageBrowser>;
  onClose: () => void;
}

/** One page owns multiple inference identities, one replay stream, and ordered checkpoints. */
export async function startSession(options: SessionOptions): Promise<PagentSession> {
  const { workspace, log } = options;
  const journal = new EventJournal(workspace.stateDirectory);
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
  let connected: () => void = () => {};
  const firstConnection = new Promise<void>(resolve => { connected = resolve; });

  function emit(event: AgentEvent, scope: EventScope = {}): void {
    if (closed) return;
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
      await flush();
      if (!browser) throw new Error("Browser is not running.");
      const epoch = runtimeEpoch;
      const cursor = lastDelivered;
      const html = await browser.snapshot();
      if (epoch !== runtimeEpoch || !pageReady) throw new Error("Runtime changed while saving; queued output was retained. Retry after reconnection.");
      const revision = await workspace.checkpoint(html);
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

  function reconnect(after: number, ids: string[]): void {
    journal.observeCursor(after);
    pageReady = false;
    const epoch = runtimeEpoch;
    const pool = agents!;
    // Retire absent identities before admitting restored ones, including at the
    // attached-agent limit. Never await their checkpoints on the delivery queue.
    for (const id of pool.ids) if (!ids.includes(id)) void pool.dispose(id).catch(error => log(String(error)));
    const available: string[] = [];
    for (const id of ids) {
      const disposing = pool.disposal(id);
      if (!disposing) { pool.register(id); available.push(id); continue; }
      // A saved element may reappear while its previous incarnation is closing.
      // Reconnect the page first: disposal may be awaiting a checkpoint queued
      // behind this navigation. Its replacement connects after disposal settles.
      void disposing.then(async () => {
        if (runtimeEpoch !== epoch || stopping || closed) return;
        const events = await pool.connectionEvents(id, options.url);
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
      connected();
    }).catch(error => { log(`Page reconnect failed: ${String(error)}`); });
  }

  async function handle(request: NativeRequest): Promise<void> {
    if (!agents || !browser) throw new Error("Pagent is still starting.");
    if (request.type === "ready") { reconnect(request.after, request.agents); return; }
    if (request.type === "cancel") { await agents.cancel(request.agentId); return; }
    if (request.type === "dispose") {
      await agents.dispose(request.agentId);
      emit({ type: "disposed" }, { agentId: request.agentId });
      return;
    }
    if (request.type === "web-continue" || request.type === "web-cancel") {
      await agents.respond(request.agentId, request.id, request.type === "web-continue");
      return;
    }
    if (stopping) throw new Error("Pagent is shutting down.");
    if (request.type === "register") {
      for (const { event, scope } of await agents.connectionEvents(request.agentId, options.url)) emit(event, scope);
      return;
    }
    if (request.type === "backend-set") { await agents.setBackendOverride(request.override); return; }
    if (request.type === "save") { await save(); return; }
    if (request.type === "reload") {
      if (reloading) throw new Error("Workspace is already reloading.");
      reloading = true;
      workspaceState();
      try { await agents.cancelAll(); await navigate(); }
      finally { reloading = false; workspaceState(); }
      return;
    }
    if (request.type === "submit") { await agents.submit(request.agentId, request.id, request.runId); return; }
  }

  function navigate(): Promise<void> {
    return pageOperation(async () => {
      await delivery;
      runtimeEpoch++;
      pageReady = false;
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
    catch (error) { emit({ type: "error", message: String(error) }); return; }
    void handle(request).catch(error => {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) },
        "agentId" in request ? { agentId: request.agentId } : {});
    });
  }

  async function cleanup(checkpoint: boolean): Promise<void> {
    stopping = true;
    const errors: unknown[] = [];
    const attempt = async (operation: () => unknown) => { try { await operation(); } catch (error) { errors.push(error); } };
    await attempt(() => agents?.cancelAll());
    if (checkpoint && pageReady && browser) {
      try { await save(); await flush(); } catch (error) { log(`Shutdown checkpoint failed: ${String(error)}`); }
    }
    closed = true;
    await pageOperations;
    await attempt(() => agents?.close());
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
      onRuntimeReset: () => { runtimeEpoch++; pageReady = false; },
      onError: error => { log(error.message); },
      onClose: () => {
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
      deliver: event => nativeBrowser.deliver(event), close: () => nativeBrowser.close(),
      async reload() {
        if (reloading) throw new Error("Workspace is already reloading.");
        reloading = true;
        workspaceState();
        try { await navigate(); }
        finally { reloading = false; workspaceState(); }
      },
    };
    options.signal?.throwIfAborted();
    if (stopping) throw new Error("Workspace tab was closed during startup.");
    agents = await SessionAgents.create({ factory, directory: workspace.directory, stateDirectory: workspace.stateDirectory,
      browserKind: options.browserKind, browser, readContext, save, diagnostics: () => diagnostics.snapshot(),
      webHeadless: options.webHeadless, emit, log, changed: workspaceState, blocked: () => stopping || reloading });
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
      getBackendState: () => agents!.getBackendState(), save, flush, close };
  } catch (error) {
    closePromise ??= cleanup(false);
    await closePromise.catch(failure => log(String(failure)));
    throw error;
  }
}
