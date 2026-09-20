// Controlled Chromium page, CDP socket and native bridge.
import { setTimeout as delay } from "node:timers/promises";
import { Cdp, object, type CdpObject } from "pi-browser/cdp";
import { chromiumConsoleText, syntheticConsole, logLocation } from "./browser-log.ts";
import type { BrowserPageOptions, EvaluationResult, HostEvent, PageBrowser } from "./protocol.ts";
import type { ChromiumBrowser } from "./chromium.ts";
import { deliveryExpression, SNAPSHOT_EXPRESSION } from "./page-scripts.ts";
import { EvaluationQueue } from "./evaluation-queue.ts";

function remoteValue(value: unknown): unknown {
  const remote = object(value);
  if ("value" in remote) return remote.value;
  if ("unserializableValue" in remote) return { type: remote.type, value: remote.unserializableValue };
  if (remote.type === "undefined") return { type: "undefined" };
  return { type: remote.subtype ?? remote.type ?? "unknown", description: remote.description ?? "" };
}

function evaluationError(details: unknown): string {
  const exception = object(details);
  const remote = object(exception.exception);
  return String(remote.description ?? exception.text ?? "JavaScript evaluation failed");
}

export class ChromiumPage implements PageBrowser {
  readonly targetId: string;
  private options: BrowserPageOptions;
  private owner: ChromiumBrowser;
  private cdp: Cdp;
  private origin: string;
  private frameId = "";
  private contextId: number | undefined;
  private contextUniqueId: string | undefined;
  private contexts = new Map<number, { frameId: string; origin: string; uniqueId: string }>();
  private lifecycle = new Map<string, Set<string>>();
  private evaluations = new EvaluationQueue();
  private logs: string[] | undefined;
  private closed = false;

  constructor(options: BrowserPageOptions, owner: ChromiumBrowser, cdp: Cdp, targetId: string) {
    this.options = options;
    this.owner = owner;
    this.cdp = cdp;
    this.targetId = targetId;
    this.origin = new URL(options.url).origin;
    cdp.onEvent((method, params) => this.receive(method, params));
  }

  dispose(notify: boolean, error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.contextId = undefined;
    this.contextUniqueId = undefined;
    this.cdp.close();
    if (error) this.report(error);
    if (notify) this.options.onClose?.();
  }

  private report(error: Error): void {
    this.options.onError?.(error);
  }

  private receive(method: string, params: CdpObject): void {
    if (this.closed) return;
    if (method === "Runtime.executionContextCreated") {
      const context = object(params.context);
      const aux = object(context.auxData);
      if (typeof context.id === "number" && aux.isDefault === true) {
        const info = { frameId: String(aux.frameId), origin: String(context.origin), uniqueId: String(context.uniqueId) };
        this.contexts.set(context.id, info);
        if (info.frameId === this.frameId && info.origin === this.origin) {
          this.contextId = context.id;
          this.contextUniqueId = info.uniqueId;
        }
      }
    } else if (method === "Runtime.executionContextDestroyed") {
      const id = params.executionContextId;
      if (typeof id === "number") this.contexts.delete(id);
      if (id === this.contextId) {
        this.contextId = undefined; this.contextUniqueId = undefined;
        this.options.onRuntimeReset?.();
      }
    } else if (method === "Runtime.executionContextsCleared") {
      this.options.onRuntimeReset?.();
      this.contexts.clear();
      this.contextId = undefined;
      this.contextUniqueId = undefined;
    } else if (method === "Page.frameNavigated") {
      const frame = object(params.frame);
      if (!frame.parentId) {
        this.frameId = String(frame.id);
        if (typeof frame.url === "string" && frame.url !== "about:blank" && new URL(frame.url).origin !== this.origin) {
          this.contextId = undefined;
          this.contextUniqueId = undefined;
          this.report(new Error(`The controlled tab left ${this.origin}; reload to return to the workspace`));
        }
      }
    } else if (method === "Page.lifecycleEvent" && params.frameId === this.frameId && typeof params.loaderId === "string") {
      const states = this.lifecycle.get(params.loaderId) ?? new Set<string>();
      states.add(String(params.name));
      this.lifecycle.set(params.loaderId, states);
      if (this.lifecycle.size > 16) this.lifecycle.delete(this.lifecycle.keys().next().value!);
    } else if (method === "Runtime.bindingCalled" && params.name === "__pagentSend" && this.contextId !== undefined && params.executionContextId === this.contextId) {
      const info = this.contexts.get(this.contextId);
      if (info?.origin !== this.origin || info.frameId !== this.frameId || typeof params.payload !== "string") return;
      try {
        const request: unknown = JSON.parse(params.payload);
        // Never await page input here: the handler may send its own CDP requests.
        queueMicrotask(() => {
          if (this.closed) return;
          try { this.options.onRequest(request); } catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
        });
      } catch { this.report(new Error("The page sent malformed native input")); }
    } else if (method === "Runtime.consoleAPICalled") {
      const level = params.type === "warning" ? "warn" : ["error", "assert"].includes(String(params.type)) ? "error" : ["debug", "trace"].includes(String(params.type)) ? "debug" : "info";
      const synthetic = syntheticConsole(params.stackTrace);
      this.options.onConsole?.({ source: "console", level, method: String(params.type), text: chromiumConsoleText(params.args),
        ...(synthetic ? { synthetic: true } : {}), ...logLocation(params.stackTrace) });
      if (params.executionContextId !== this.contextId || !this.logs || synthetic || this.logs.length >= 200) return;
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args.map(arg => {
        const value = remoteValue(arg);
        return typeof value === "string" ? value : JSON.stringify(value);
      }).join(" ");
      this.logs.push(`${String(params.type)}: ${text}`.slice(0, 8_000));
    } else if (method === "Runtime.exceptionThrown") {
      const details = object(params.exceptionDetails);
      const exception = details.exception ? chromiumConsoleText([details.exception]) : "";
      this.options.onConsole?.({
        source: "exception", level: "error",
        text: [details.text, exception].filter(Boolean).join(": "),
        ...logLocation(details.stackTrace, details),
      });
    } else if (method === "Fetch.requestPaused") {
      const request = object(params.request);
      const topLevel = params.frameId === this.frameId;
      const url = String(request.url);
      const permitted = !topLevel || new URL(url).origin === this.origin;
      const action = permitted ? "Fetch.continueRequest" : "Fetch.failRequest";
      const arguments_: CdpObject = { requestId: params.requestId };
      if (!permitted) {
        arguments_.errorReason = "BlockedByClient";
        this.report(new Error(`Blocked main-tab navigation outside workspace origin: ${url}`));
      }
      void this.cdp.request(action, arguments_).catch(error => { if (!this.closed) this.report(error as Error); });
    }
  }

  async initialize(): Promise<void> {
    await this.cdp.request("Page.enable");
    const tree = await this.cdp.request("Page.getFrameTree");
    this.frameId = String(object(object(tree.frameTree).frame).id);
    await this.cdp.request("Page.setLifecycleEventsEnabled", { enabled: true });
    await this.cdp.request("Runtime.enable");
    await this.cdp.request("Runtime.addBinding", { name: "__pagentSend" });
    await this.cdp.request("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        if (window !== window.top || location.origin !== ${JSON.stringify(this.origin)}) return;
        globalThis.$ = document.querySelector.bind(document);
        const nativeSend = globalThis.__pagentSend;
        const port = new EventTarget();
        port.send = request => nativeSend(JSON.stringify(request));
        globalThis.aos = port;
      })()`,
    });
    await this.cdp.request("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] });
    await this.cdp.request("Emulation.setDeviceMetricsOverride", {
      width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false,
    });
    await this.reload();
    await this.cdp.request("Page.bringToFront");
  }

  private context(): string {
    if (this.closed) throw new Error("The controlled browser is closed");
    if (!this.contextUniqueId) throw new Error("Workspace execution context is unavailable; wait for navigation or reload the page");
    return this.contextUniqueId;
  }

  evaluate(code: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<EvaluationResult> {
    return this.evaluations.enqueue(() => this.runEvaluation(code, options), options.signal);
  }

  private async runEvaluation(code: string, options: { signal?: AbortSignal; timeoutMs?: number }): Promise<EvaluationResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Evaluation timeout must be positive");
    if (options.signal?.aborted) throw new Error("Browser evaluation cancelled");
    const uniqueContextId = this.context();
    const logs: string[] = [];
    this.logs = logs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let interrupted: Error | undefined;
    let terminate: Promise<unknown> | undefined;
    let rejectInterrupt: (error: Error) => void = () => {};
    const interrupt = (message: string) => {
      if (interrupted) return;
      interrupted = new Error(message);
      terminate = this.cdp.request("Runtime.terminateExecution", {}, 3_000).catch(() => {});
      rejectInterrupt(interrupted);
    };
    const abort = () => interrupt("Browser evaluation cancelled; JavaScript execution terminated");
    try {
      const interruption = new Promise<never>((_resolve, reject) => {
        rejectInterrupt = reject;
        timer = setTimeout(() => interrupt(`Browser evaluation timed out after ${timeoutMs}ms; JavaScript execution terminated`), timeoutMs);
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      const evaluation = this.cdp.request("Runtime.evaluate", {
        expression: code,
        uniqueContextId,
        awaitPromise: true,
        returnByValue: false,
        replMode: true,
        timeout: timeoutMs,
        objectGroup: "pagent-console",
      }, timeoutMs + 5_000).then(async response => {
        const remote = object(response.result);
        if (!response.exceptionDetails && remote.type === "object" && typeof remote.objectId === "string") {
          // REPL evaluation awaits its own wrapper, not necessarily a Promise
          // returned by the user's expression. Resolve the actual value once,
          // without evaluating user code a second time.
          return this.cdp.request("Runtime.callFunctionOn", {
            objectId: remote.objectId, functionDeclaration: "function() { return this; }",
            returnByValue: true, awaitPromise: true, objectGroup: "pagent-console",
          }, timeoutMs + 5_000);
        }
        return response;
      });
      const response = await Promise.race([evaluation, interruption]);
      return {
        value: remoteValue(response.result), logs,
        ...(response.exceptionDetails ? { error: evaluationError(response.exceptionDetails) } : {}),
      };
    } catch (error) {
      if (interrupted) throw interrupted;
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      await terminate;
      this.logs = undefined;
      await this.cdp.request("Runtime.releaseObjectGroup", { objectGroup: "pagent-console" }, 1_000).catch(() => {});
    }
  }

  async evaluateValue(expression: string): Promise<unknown> {
    const response = await this.cdp.request("Runtime.evaluate", {
      expression: `${expression}\n//# sourceURL=pagent-internal`,
      uniqueContextId: this.context(), awaitPromise: true, returnByValue: true, timeout: 5_000,
    }, 7_000);
    if (response.exceptionDetails) throw new Error(evaluationError(response.exceptionDetails));
    return remoteValue(response.result);
  }

  async snapshot(): Promise<string> {
    const value = await this.evaluateValue(SNAPSHOT_EXPRESSION);
    if (typeof value !== "string") throw new Error("Document serialization did not return HTML");
    return value;
  }

  async reload(): Promise<void> {
    if (this.closed) throw new Error("The controlled browser is closed");
    const response = await this.cdp.request("Page.navigate", { url: this.options.url });
    if (response.errorText) throw new Error(`Workspace navigation failed: ${String(response.errorText)}`);
    const loaderId = response.loaderId;
    if (typeof loaderId !== "string") throw new Error("Workspace reload did not create a document loader");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (this.lifecycle.get(loaderId)?.has("DOMContentLoaded") && this.contextUniqueId) return;
      await delay(20);
    }
    throw new Error("Workspace navigation did not finish within 15 seconds");
  }

  async deliver(event: HostEvent): Promise<void> {
    await this.evaluateValue(deliveryExpression(event));
  }

  async screenshot(): Promise<string> {
    const response = await this.cdp.request("Page.captureScreenshot", { format: "png", fromSurface: true });
    if (typeof response.data !== "string") throw new Error("Chromium did not return a screenshot");
    return response.data;
  }

  close(): Promise<void> {
    return this.owner.close();
  }
}
