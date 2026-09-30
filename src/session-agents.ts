import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveWebSettings, type WebBackend, type WebBackendState } from "pi-browser/web";
import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { EngineFactory } from "./agent.ts";
import { MAX_AGENTS, Runs, terminal, validateAgentId } from "./runs.ts";
import { WebAttentionCoordinator } from "./web-tools.ts";
import { readWebBackendOverride, writeWebBackendOverride } from "./web-backend.ts";
import { buildSystemPrompt } from "./prompt.ts";
import { resolvePrompt, recordTurnPrompts, type TurnPrompts } from "./turn-prompts.ts";
import type { AgentEngine, AgentEvent, AgentRun, BrowserKind, HostEvent, PageBrowser, PageContext } from "./protocol.ts";
import { agentConfiguration, effectiveTools, TOOL_NAMES, type AgentConfiguration, type ToolName, type CheckpointPolicy } from "./agent-config.ts";

export type EventScope = Pick<HostEvent, "agentId" | "requestId" | "runId">;
interface AgentEntry {
  id: string;
  configuration: AgentConfiguration;
  tools: ToolName[];
  ready: Promise<AgentEngine>;
  attention: WebAttentionCoordinator;
  run?: AgentRun;
  abort?: AbortController;
  submission?: Promise<void>;
  closing?: Promise<void>;
}
interface Options {
  factory: EngineFactory;
  directory: string;
  stateDirectory: string;
  browserKind: BrowserKind;
  browser: PageBrowser;
  webHeadless?: boolean;
  tools?: ToolName[];
  http?: string[];
  network?: "open" | "local";
  checkpoint?: CheckpointPolicy;
  readResource?: (resource: string) => Promise<Buffer>;
  completed?: (run: AgentRun) => void;
  diagnostics: () => unknown;
  readContext: (agentId: string, inputId?: string) => Promise<PageContext>;
  save: () => Promise<string>;
  emit: (event: AgentEvent, scope?: EventScope) => void;
  changed: () => void;
  blocked: () => boolean;
  log: (message: string) => void;
}

/** Workspace-owned inference identities. No default/privileged agent or hidden transcript. */
export class SessionAgents {
  readonly engines = new Map<string, AgentEngine>();
  private entries = new Map<string, AgentEntry>();
  private runs = new Runs();
  private options: Options;
  private backend: WebBackendState;
  private updates: Promise<void> = Promise.resolve();
  private stopped = false;

  private constructor(options: Options, override: WebBackend | null) {
    this.options = options;
    const configured = resolveWebSettings().backend;
    this.backend = { configured, override, effective: override ?? configured,
      source: override !== null ? "override" : process.env.PI_WEB_BACKEND !== undefined ? "environment" : "default" };
  }

  static async create(options: Options): Promise<SessionAgents> {
    return new SessionAgents(options, await readWebBackendOverride(options.stateDirectory));
  }

  get modelLabel(): string { return this.options.factory.modelLabel; }
  get busy(): boolean { return [...this.entries.values()].some(entry => entry.submission !== undefined); }
  get ids(): string[] { return [...this.entries.keys()]; }
  get participants(): { id: string; configuration: AgentConfiguration }[] { return [...this.entries.values()].filter(entry => !entry.closing).map(entry => ({ id: entry.id, configuration: structuredClone(entry.configuration) })); }
  idle(id: string): boolean { const entry = this.entries.get(id); return Boolean(entry && !entry.closing && !entry.submission); }
  disposal(id: string): Promise<void> | undefined { return this.entries.get(id)?.closing; }
  getBackendState(): WebBackendState { return { ...this.backend }; }

  setBackendOverride(override: WebBackend | null): Promise<void> {
    const update = this.updates.then(async () => {
      if (this.stopped) throw new Error("Agent workspace is closing.");
      await writeWebBackendOverride(this.options.stateDirectory, override);
      this.backend = { ...this.backend, override, effective: override ?? this.backend.configured,
        source: override !== null ? "override" : process.env.PI_WEB_BACKEND !== undefined ? "environment" : "default" };
      for (const entry of this.entries.values()) {
        if (!entry.closing) await (await entry.ready).setBackendOverride(override);
      }
      this.options.emit({ type: "backend-state", state: this.getBackendState() });
    });
    this.updates = update.catch(() => {});
    return update;
  }

  register(id: string, requested?: AgentConfiguration): AgentEntry {
    validateAgentId(id);
    if (this.stopped) throw new Error("Agent workspace is closing.");
    const existing = this.entries.get(id);
    if (existing?.closing) throw new Error(`Agent ${id} is still being disposed. Wait before reusing its ID.`);
    if (existing) {
      if (requested && JSON.stringify(agentConfiguration(requested)) !== JSON.stringify(existing.configuration)) throw new Error(`Agent ${id} configuration is pinned while attached; remove it before changing settings.`);
      return existing;
    }
    const configuration = agentConfiguration(requested ?? {});
    const tools = effectiveTools(configuration, this.options.tools ?? [...TOOL_NAMES], this.options.network ?? "open", this.options.checkpoint ?? "document");
    if ([...this.entries.values()].filter(entry => !entry.closing).length >= MAX_AGENTS) throw new Error(`At most ${MAX_AGENTS} agents may be attached to one workspace.`);
    const ready = Promise.withResolvers<AgentEngine>();
    const entry: AgentEntry = { id, configuration, tools, ready: ready.promise,
      attention: new WebAttentionCoordinator(event => this.emit(entry, event)) };
    this.entries.set(id, entry);
    void (async () => {
      return this.options.factory.create({
      cwd: this.options.directory, agentId: id, browserKind: this.options.browserKind, browser: this.options.browser,
      model: configuration.model, tools, http: this.options.http, network: this.options.network,
      checkpoint: this.options.checkpoint, blocked: this.options.blocked,
      diagnostics: this.options.diagnostics, readContext: () => this.options.readContext(id), save: this.options.save,
      webProfileDir: join(this.options.stateDirectory, "research", createHash("sha256").update(id).digest("hex")),
      webSnapshotDirectory: join(this.options.stateDirectory, "web-snapshots", createHash("sha256").update(id).digest("hex")),
      webHeadless: this.options.webHeadless,
      onWebAttention: (request, signal) => entry.attention.wait(request, signal),
      waitForRuns: async (ids, signal) => {
        const run = entry.run;
        if (!run || terminal(run)) throw new Error("No active run to join from.");
        run.status = "waiting";
        this.emit(entry, { type: "run", run });
        try { return await this.runs.wait(run.id, ids, signal); }
        finally {
          if (!terminal(run)) { run.status = "running"; this.emit(entry, { type: "run", run }); }
        }
      },
      emit: event => {
        if (event.type === "backend-state" || event.type === "status" && event.status === "idle") return;
        if (event.type === "message" && event.phase === "end" && entry.run) {
          const message = event.message;
          if (message && typeof message === "object" && "role" in message && message.role === "assistant" && "content" in message && Array.isArray(message.content)) {
            const text = message.content.flatMap((block: unknown) => block && typeof block === "object" && "type" in block && block.type === "text" && "text" in block && typeof block.text === "string" ? [block.text] : []).join("\n");
            if (text) {
              const result = truncateHead(text, { maxBytes: 50 * 1024, maxLines: 2000 });
              entry.run.result = result.content + (result.truncated ? "\n[Run answer truncated; inspect the agent's messages for full text.]" : "");
            }
          }
        }
        this.emit(entry, event);
      },
      });
    })().then(async engine => {
      this.engines.set(id, engine);
      await engine.setBackendOverride(this.backend.override);
      return engine;
    }).then(ready.resolve, ready.reject);
    void entry.ready.catch(() => {}); // Callers report startup failure in their scoped control/run response.
    return entry;
  }

  private emit(entry: AgentEntry, event: AgentEvent): void {
    this.options.emit(event, { agentId: entry.id, ...(entry.run ? { requestId: entry.run.inputId, runId: entry.run.id } : {}) });
  }

  async connectionEvents(id: string, url: string, configuration?: AgentConfiguration): Promise<{ event: AgentEvent; scope: EventScope }[]> {
    const entry = this.register(id, configuration);
    const engine = await entry.ready;
    const events: AgentEvent[] = [
      { type: "connected", url, model: engine.modelLabel, tools: entry.tools, busy: entry.submission !== undefined,
        ...(entry.run ? { run: structuredClone(entry.run) } : {}) },
      { type: "web-attention", request: entry.attention.current },
      { type: "backend-state", state: this.getBackendState() },
    ];
    return events.map(event => ({ event, scope: { agentId: id,
      ...(entry.run && event.type !== "backend-state" ? { requestId: entry.run.inputId, runId: entry.run.id } : {}) } }));
  }

  async resolveTurnPrompts(agentId: string, manualText?: string): Promise<TurnPrompts> {
    const entry = this.entries.get(agentId);
    if (!entry || entry.closing) throw new Error(`Agent ${agentId} is not registered.`);
    const { configuration } = entry;
    const system = configuration.systemPromptSource
      ? await resolvePrompt(configuration.systemPromptSource, this.options.browser, this.options.readResource)
      : { source: null, text: buildSystemPrompt(this.options.browserKind, { ...this.options, tools: entry.tools }) };
    const source = manualText === undefined ? configuration.repeatPromptSource : { kind: "raw" as const, value: manualText };
    if (!source) throw new Error("Agent has no repeat prompt source.");
    const user = await resolvePrompt(source, this.options.browser, this.options.readResource);
    return { resolvedAt: new Date().toISOString(), system, user };
  }

  submit(agentId: string, inputId: string, runId: string, prepared?: TurnPrompts): Promise<void> {
    let entry: AgentEntry;
    let run: AgentRun;
    try {
      if (this.options.blocked()) throw new Error("Workspace is busy or execution has stopped. Wait before submitting.");
      const registered = this.entries.get(agentId);
      if (!registered || registered.closing) throw new Error(`Agent ${agentId} is not registered.`);
      entry = registered;
      if (entry.submission) throw new Error("Agent is busy. Cancel or wait before submitting.");
      if (this.options.blocked()) throw new Error("Workspace is busy or shutting down. Wait before submitting.");
      run = this.runs.start(runId, agentId, inputId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.options.emit({ type: "error", message }, { agentId, requestId: inputId, runId });
      // Never replace an existing run's receipt on a duplicate native submission.
      if (!this.runs.get(runId)) {
        const rejected: AgentRun = { id: runId, agentId, inputId, status: "error", result: "", error: message };
        this.runs.reject(rejected);
        this.options.emit({ type: "run", run: rejected }, { agentId, requestId: inputId, runId });
      }
      return Promise.resolve();
    }
    entry.run = run;
    const abort = new AbortController();
    entry.abort = abort;
    entry.submission = Promise.resolve().then(async () => {
      let status: AgentRun["status"] = "complete";
      try {
        const engine = await entry.ready;
        abort.signal.throwIfAborted();
        const context = await this.options.readContext(agentId, inputId);
        abort.signal.throwIfAborted();
        if (!context.prompt?.trim()) throw new Error("collectContext(agentId, inputId) returned an empty prompt.");
        const prompts = prepared ?? await this.resolveTurnPrompts(agentId, context.prompt);
        abort.signal.throwIfAborted();
        if (prompts.user.text !== context.prompt) throw new Error("Scheduled prompt changed before submission; refusing a different instruction.");
        await recordTurnPrompts(this.options.stateDirectory, { agentId, inputId, runId }, prompts);
        abort.signal.throwIfAborted();
        this.emit(entry, { type: "turn-prompts", prompts });
        await this.options.save(); // Persist accepted input/branch and prompt evidence before inference.
        abort.signal.throwIfAborted();
        if (this.options.blocked()) throw new Error("Execution has stopped.");
        status = await engine.submit({ id: runId, prompt: prompts.user.text, systemPrompt: prompts.system.text, history: context.history });
        if (abort.signal.aborted) status = "cancelled";
      } catch (error) {
        status = abort.signal.aborted ? "cancelled" : "error";
        if (status === "error") {
          run.error = error instanceof Error ? error.message : String(error);
          this.emit(entry, { type: "error", message: run.error });
        }
      } finally {
        try { await this.options.save(); }
        catch (error) { this.options.log(`Turn checkpoint failed: ${String(error)}`); }
        if (abort.signal.aborted) status = "cancelled";
        run.status = status;
        this.emit(entry, { type: "run", run });
        this.runs.finish(run);
        entry.submission = undefined;
        entry.abort = undefined;
        this.options.changed();
        this.options.completed?.(structuredClone(run));
      }
    });
    this.emit(entry, { type: "run", run });
    this.options.changed();
    return entry.submission;
  }

  rejectScheduled(agentId: string, inputId: string, runId: string): void {
    if (this.runs.get(runId)) return;
    const run: AgentRun = { id: runId, agentId, inputId, status: "cancelled", result: "", error: "Scheduled prompt was cancelled before submission." };
    this.runs.reject(run);
    this.options.emit({ type: "run", run }, { agentId, requestId: inputId, runId });
  }

  async cancel(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown agent: ${id}`);
    entry.abort?.abort();
    entry.attention.cancel();
    const engine = await entry.ready.catch(() => undefined);
    await engine?.cancel();
    await entry.submission;
  }

  async respond(id: string, attentionId: string, continued: boolean): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown agent: ${id}`);
    entry.attention.respond(attentionId, continued);
    if (!continued) await this.cancel(id);
  }

  dispose(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return Promise.resolve();
    entry.closing ??= (async () => {
      try { await this.cancel(id); await (await entry.ready.catch(() => undefined))?.close(); }
      finally { this.entries.delete(id); this.engines.delete(id); this.options.changed(); }
    })();
    return entry.closing;
  }

  async cancelAll(): Promise<void> { await Promise.all([...this.entries.keys()].map(id => this.cancel(id))); }
  async close(): Promise<void> {
    this.stopped = true;
    await this.updates;
    const results = await Promise.allSettled([...this.entries.keys()].map(id => this.dispose(id)));
    const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new AggregateError(errors, "Agent cleanup failed");
  }
}
