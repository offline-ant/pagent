import type { WebAttention, WebBackend, WebBackendState } from "pi-browser/web";

export interface AgentRun {
  id: string;
  agentId: string;
  inputId: string;
  status: "running" | "waiting" | "complete" | "cancelled" | "error";
  result: string;
  error?: string;
}

/** Browser-owned protocol. Host records carry sequence numbers for reconnect/deduplication. */
export type AgentEvent =
  | { type: "message"; phase: "start" | "update" | "end"; message: unknown }
  | { type: "tool"; phase: "start" | "update" | "end"; callId: string; name: string; args?: unknown; result?: unknown; isError?: boolean }
  | { type: "status"; status: "running" | "idle"; model?: string }
  | { type: "error"; message: string }
  | { type: "saved"; revision: string }
  | { type: "connected"; url: string; model: string; busy: boolean; run?: AgentRun }
  | { type: "workspace-state"; busy: boolean; reloading?: boolean }
  | { type: "disposed" }
  | { type: "run"; run: AgentRun }
  | { type: "web-attention"; request: WebAttention | null }
  | { type: "web-progress"; message: string }
  | { type: "backend-state"; state: WebBackendState };

export interface HostEvent {
  seq: number;
  agentId?: string;
  requestId?: string;
  runId?: string;
  event: AgentEvent;
}

export type NativeRequest =
  | { type: "ready"; after: number; agents: string[] }
  | { type: "register"; agentId: string }
  | { type: "dispose"; agentId: string }
  | { type: "submit"; agentId: string; id: string; runId: string }
  | { type: "cancel"; agentId: string }
  | { type: "save" }
  | { type: "reload" }
  | { type: "web-continue"; agentId: string; id: string }
  | { type: "web-cancel"; agentId: string; id: string }
  | { type: "backend-set"; override: WebBackend | null };

/** Supplied by editable window.pagent.collectContext(agentId, inputId?) in the document. */
export interface PageContext {
  memory: string;
  outline: string;
  history: unknown[];
  prompt?: string;
}

export interface Submission {
  id: string;
  prompt: string;
  history: unknown[];
}

export interface EvaluationResult {
  value: unknown;
  logs: string[];
  error?: string;
}

export type BrowserKind = "chromium" | "firefox";

export interface BrowserLog {
  /** Synthetic conversation mirror: forwarded to stdout, never model diagnostics. */
  synthetic?: boolean;
  source: "console" | "exception";
  level: string;
  method?: string;
  text: string;
  url?: string;
  line?: number;
  column?: number;
  stack?: string;
}

export interface BrowserPageOptions {
  url: string;
  onRequest: (request: unknown) => void;
  /** Called synchronously when the controlled runtime is invalidated. */
  onRuntimeReset?: () => void;
  onError?: (error: Error) => void;
  /** All observed page console entries and uncaught errors, including outside tools. */
  onConsole?: (entry: BrowserLog) => void;
  /** A human closed this tab; not called by explicit close() or runtime recovery. */
  onClose?: () => void;
}

export interface BrowserOptions extends BrowserPageOptions {
  browser?: BrowserKind;
  profileDir: string;
  headless: boolean;
  executable?: string;
  /** Explicit opt-out only; never silently disable Chromium's sandbox. */
  noSandbox?: boolean;
}

export interface PageBrowser {
  evaluate(code: string, options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvaluationResult>;
  evaluateValue(expression: string): Promise<unknown>;
  snapshot(): Promise<string>;
  reload(): Promise<void>;
  deliver(event: HostEvent): Promise<void>;
  screenshot(): Promise<string>;
  close(): Promise<void>;
}

export interface AgentEngine {
  readonly modelLabel: string;
  readonly busy: boolean;
  getBackendState(): WebBackendState;
  setBackendOverride(override: WebBackend | null): Promise<void>;
  submit(input: Submission): Promise<"complete" | "cancelled">;
  cancel(): Promise<void>;
  close(): Promise<void>;
}

export interface EngineOptions {
  cwd: string;
  agentId?: string;
  diagnostics?: () => unknown;
  waitForRuns?: (runs: string[], signal?: AbortSignal) => Promise<AgentRun[]>;
  model?: string;
  thinking?: string;
  fake?: boolean;
  browserKind?: BrowserKind;
  webProfileDir?: string;
  /** Private agent-scoped evidence; retained independently of engine/browser lifetime. */
  webSnapshotDirectory?: string;
  webStateDirectory?: string;
  webHeadless?: boolean;
  onWebAttention?: (request: WebAttention, signal?: AbortSignal) => Promise<boolean>;
  browser: PageBrowser;
  readContext: () => Promise<PageContext>;
  save: () => Promise<string>;
  emit: (event: AgentEvent) => void;
}
