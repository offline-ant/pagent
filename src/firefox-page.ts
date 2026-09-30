import { BidiCommandError, object, remoteValue, type BidiObject } from "pi-browser/bidi";
import { firefoxConsoleText, syntheticConsole, logLocation } from "./browser-log.ts";
import type { FirefoxProcess, FirefoxRuntime } from "./firefox-process.ts";
import { deliveryExpression, mirrorExpression, SNAPSHOT_EXPRESSION } from "./page-scripts.ts";
import { localResource } from "./browser-policy.ts";
import { EvaluationQueue } from "./evaluation-queue.ts";
import type { BrowserPageOptions, EvaluationResult, HostEvent, PageBrowser } from "./protocol.ts";

interface PageRuntime {
  runtime: FirefoxRuntime;
  context: string;
  realm?: string;
}

export class FirefoxPage implements PageBrowser {
  readonly options: BrowserPageOptions;
  readonly owner: FirefoxProcess;
  readonly origin: string;
  state?: PageRuntime;
  closed = false;
  private evaluations = new EvaluationQueue();
  private logs?: { state: PageRuntime; entries: string[] };

  constructor(owner: FirefoxProcess, options: BrowserPageOptions) {
    const url = new URL(options.url);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Workspace URL must use HTTP or HTTPS");
    this.options = options;
    this.owner = owner;
    this.origin = url.origin;
  }

  report(error: Error): void { this.options.onError?.(error); }

  invalidate(): void {
    if (!this.state) return;
    this.state = undefined;
    this.options.onRuntimeReset?.();
  }

  markClosed(): void {
    this.closed = true;
    this.invalidate();
  }

  receive(runtime: FirefoxRuntime, method: string, params: BidiObject): void {
    const state = this.state;
    if (!state || state.runtime !== runtime || this.closed) return;
    if (method === "script.realmCreated" && params.type === "window" && params.sandbox === undefined && params.context === state.context && params.origin === this.origin) {
      state.realm = String(params.realm);
    } else if (method === "script.realmDestroyed" && params.realm === state.realm) {
      state.realm = undefined;
      this.options.onRuntimeReset?.();
    } else if (method === "browsingContext.contextDestroyed" && params.context === state.context) {
      this.owner.humanClosed();
    } else if (method === "script.message" && params.channel === "pagent") {
      const source = object(params.source);
      if (source.context !== state.context || !state.realm || source.realm !== state.realm) return;
      try {
        const request: unknown = remoteValue(params.data);
        queueMicrotask(() => {
          if (this.state !== state || state.realm !== source.realm || this.closed) return;
          try { this.options.onRequest(request); }
          catch (error) { this.report(error instanceof Error ? error : new Error(String(error))); }
        });
      } catch { this.report(new Error("The page sent malformed native input")); }
    } else if (method === "log.entryAdded" && (params.type === "console" || params.type === "javascript")) {
      const source = object(params.source);
      if (!this.owner.belongs(runtime, String(source.context), state.context)) return;
      const synthetic = params.type === "console" && syntheticConsole(params.stackTrace);
      this.options.onConsole?.({
        source: params.type === "console" ? "console" : "exception", level: String(params.level),
        ...(synthetic ? { synthetic: true } : {}),
        ...(params.type === "console" ? { method: String(params.method) } : {}),
        text: params.type === "console" ? firefoxConsoleText(params) : String(params.text ?? "JavaScript error"),
        ...logLocation(params.stackTrace),
      });
      if (params.type !== "console" || source.context !== state.context || source.realm !== state.realm || this.logs?.state !== state || synthetic || this.logs.entries.length >= 200) return;
      const args = Array.isArray(params.args) ? params.args : [];
      const text = args.map(arg => {
        const value = remoteValue(arg);
        return typeof value === "string" ? value : JSON.stringify(value);
      }).join(" ");
      this.logs.entries.push(`${String(params.method)}: ${text}`.slice(0, 8_000));
    } else if (method === "network.beforeRequestSent" && params.isBlocked === true && (this.options.network === "local" || this.owner.belongs(runtime, String(params.context), state.context))) {
      const request = object(params.request);
      const url = String(request.url);
      const mainDocument = params.context === state.context && request.destination === "document";
      const permitted = this.options.network === "local"
        ? (request.destination === "document" ? mainDocument && new URL(url).origin === this.origin : localResource(url, this.origin))
        : !mainDocument || new URL(url).origin === this.origin;
      void runtime.bidi.request(permitted ? "network.continueRequest" : "network.failRequest", { request: request.request }).catch(error => {
        if (this.state === state && !this.closed) this.report(error as Error);
      });
      if (!permitted) this.report(new Error(this.options.network === "local"
        ? `Blocked request by local network policy: ${url}`
        : `Blocked main-tab navigation outside workspace origin: ${url}`));
    }
  }

  async attach(runtime: FirefoxRuntime, context: string): Promise<void> {
    if (this.closed || this.owner.runtime !== runtime) throw new Error("Firefox runtime changed while opening the workspace");
    this.state = { runtime, context };
    runtime.parents.set(context, null);
    // Firefox 152 can invoke a preload twice; replacing the first port loses its messages.
    await runtime.bidi.request("script.addPreloadScript", {
      contexts: [context],
      functionDeclaration: `(send) => {
        if (window !== window.top || location.origin !== ${JSON.stringify(this.origin)} || Object.hasOwn(globalThis, "aos")) return;
        globalThis.$ = document.querySelector.bind(document);
        const port = new EventTarget();
        port.send = send;
        globalThis.aos = port;
      }`,
      arguments: [{ type: "channel", value: { channel: "pagent", ownership: "none", serializationOptions: { maxObjectDepth: 20 } } }],
    });
    await runtime.bidi.request("network.addIntercept", { phases: ["beforeRequestSent"], ...(this.options.network === "local" ? {} : { contexts: [context] }) });
    await runtime.bidi.request("browsingContext.setViewport", { context, viewport: this.options.viewport ?? { width: 1440, height: 1100 }, devicePixelRatio: 1 });
    await this.navigate();
  }

  private async current(): Promise<PageRuntime> {
    await this.owner.recovery;
    if (this.closed || this.owner.closed) throw new Error("The controlled browser is closed");
    if (!this.state?.realm || this.owner.runtime !== this.state.runtime) throw new Error("Workspace execution context is unavailable; reload the page");
    return this.state;
  }

  evaluate(code: string, options: { signal?: AbortSignal; timeoutMs?: number; preserveOnAbort?: () => boolean } = {}): Promise<EvaluationResult> {
    return this.evaluations.enqueue(() => this.runEvaluation(code, options, false), options.signal);
  }

  private async runEvaluation(code: string, options: { signal?: AbortSignal; timeoutMs?: number; preserveOnAbort?: () => boolean }, internal: boolean, source = "pagent-internal"): Promise<EvaluationResult> {
    const timeoutMs = options.timeoutMs ?? 15_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("Evaluation timeout must be positive");
    const state = await this.current();
    if (options.signal?.aborted) throw new Error("Browser evaluation cancelled before execution");
    const logs: string[] = [];
    if (!internal) this.logs = { state, entries: logs };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let rejectInterrupt: (error: Error) => void = () => {};
    let preserve = false;
    const abort = () => {
      preserve = options.preserveOnAbort?.() ?? false;
      rejectInterrupt(new Error(preserve ? "Browser evaluation detached for deadline pause; JavaScript may continue in the live page" : "Browser evaluation cancelled"));
    };
    try {
      const interruption = new Promise<never>((_resolve, reject) => {
        rejectInterrupt = reject;
        timer = setTimeout(() => reject(new Error(`Browser evaluation timed out after ${timeoutMs}ms`)), timeoutMs);
      });
      options.signal?.addEventListener("abort", abort, { once: true });
      const response = await Promise.race([
        state.runtime.bidi.request("script.evaluate", {
          expression: internal ? `${code}\n//# sourceURL=${source}` : code,
          target: { realm: state.realm }, awaitPromise: true, resultOwnership: "none",
          serializationOptions: { maxObjectDepth: 20, maxDomDepth: 0 },
        }, timeoutMs + 1_000),
        interruption,
      ]);
      return {
        value: remoteValue(response.result), logs,
        ...(response.type === "exception" ? { error: String(object(response.exceptionDetails).text ?? "JavaScript evaluation failed") } : {}),
      };
    } catch (error) {
      if (this.closed || this.owner.closed) throw new Error("The controlled browser is closed");
      if (preserve) throw error;
      if (error instanceof BidiCommandError) return { value: { type: "undefined" }, logs, error: error.message };
      // Terminal shutdown owns process termination. Never replace the live world
      // while its recorder/checkpoint is finishing, even if an internal call fails.
      if (this.owner.stopping) throw new Error(`${String(error)}; Firefox is stopping without runtime recovery`);
      // BiDi cannot terminate a script. Restart the workspace from saved HTML,
      // losing every page agent's unsaved DOM/runtime state.
      try { await this.owner.reset(state.runtime, !internal); }
      catch (recoveryError) { throw new Error(`${String(error)}; Firefox runtime stopped; unsaved state lost; recovery failed: ${String(recoveryError)}`); }
      const notice = this.owner.runtime
        ? "Firefox runtime reset from the saved workspace; unsaved DOM and JavaScript state lost for all agents in the page"
        : "Firefox runtime stopped; unsaved state lost for all agents in the page. Explicitly reload or restore the page before continuing";
      throw new Error(`${error instanceof Error ? error.message : String(error)}; ${notice}`);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (!internal && this.logs?.entries === logs) this.logs = undefined;
    }
  }

  async evaluateValue(expression: string, source = "pagent-internal"): Promise<unknown> {
    const result = await this.runEvaluation(expression, { timeoutMs: 5_000 }, true, source);
    if (result.error) throw new Error(result.error);
    return result.value;
  }

  async snapshot(): Promise<string> {
    const value = await this.evaluateValue(SNAPSHOT_EXPRESSION);
    if (typeof value !== "string") throw new Error("Document serialization did not return HTML");
    return value;
  }

  async navigate(): Promise<void> {
    const state = this.state;
    if (!state || this.closed || this.owner.runtime !== state.runtime) throw new Error("Workspace execution context is unavailable; reload the page");
    await state.runtime.bidi.request("browsingContext.navigate", { context: state.context, url: this.options.url, wait: "interactive" });
    if (this.state !== state || !state.realm) throw new Error("Firefox navigation did not create a workspace execution realm");
  }

  reload(): Promise<void> { return this.owner.reload(); }

  async deliver(event: HostEvent): Promise<void> {
    await this.evaluateValue(mirrorExpression(event), "pagent-agent-mirror");
    await this.evaluateValue(deliveryExpression(event));
  }

  async captureFrame(options: { screenshot: boolean }): Promise<{ html: string; screenshot?: string }> {
    const state = this.state;
    if (this.closed || !state?.realm || this.owner.runtime !== state.runtime) throw new Error("Workspace execution context is unavailable for capture");
    // A named sandbox has its own built-ins. Unlike internal control operations,
    // a failed sample never resets Firefox or discards the shared live page.
    const response = await state.runtime.bidi.request("script.evaluate", {
      expression: SNAPSHOT_EXPRESSION, target: { context: state.context, sandbox: "pagent-recorder" },
      awaitPromise: false, resultOwnership: "none",
    }, 2_500);
    if (response.type === "exception") throw new Error(String(object(response.exceptionDetails).text ?? "Document capture failed"));
    const html = remoteValue(response.result);
    if (typeof html !== "string") throw new Error("Document serialization did not return HTML");
    if (!options.screenshot) return { html };
    const image = await state.runtime.bidi.request("browsingContext.captureScreenshot", { context: state.context, origin: "viewport" }, 2_500);
    if (typeof image.data !== "string") throw new Error("Firefox did not return a screenshot");
    return { html, screenshot: image.data };
  }

  async screenshot(): Promise<string> {
    const state = await this.current();
    const response = await state.runtime.bidi.request("browsingContext.captureScreenshot", { context: state.context });
    if (typeof response.data !== "string") throw new Error("Firefox did not return a screenshot");
    return response.data;
  }

  prepareToStop(): void { this.owner.stopping = true; }

  close(): Promise<void> { return this.owner.close(); }
}
