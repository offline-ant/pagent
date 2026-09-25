import { setTimeout as delay } from "node:timers/promises";
import { BrowserProcessLauncher, type NativeBrowserProcess } from "pi-browser";
import { Bidi, object, type BidiObject } from "pi-browser/bidi";
import { FirefoxPage } from "./firefox-page.ts";
import type { BrowserOptions } from "./protocol.ts";

export interface FirefoxRuntime {
  process: NativeBrowserProcess;
  bidi: Bidi;
  parents: Map<string, string | null>;
}

/** Workspace recovery is application policy; native processes use pi-browser's profile lease. */
export class FirefoxProcess {
  readonly page: FirefoxPage;
  runtime?: FirefoxRuntime;
  recovery?: Promise<void>;
  closed = false;
  stopping = false;
  private launcher: BrowserProcessLauncher;
  private lifecycle: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;

  constructor(options: BrowserOptions, launcher: BrowserProcessLauncher) {
    this.launcher = launcher;
    this.page = new FirefoxPage(this, options);
  }

  private operation<T>(run: () => Promise<T>): Promise<T> {
    const result = this.lifecycle.then(run);
    this.lifecycle = result.catch(() => {});
    return result;
  }

  start(): Promise<void> { return this.operation(() => this.initialize()); }

  private receive(runtime: FirefoxRuntime, method: string, params: BidiObject): void {
    if (this.runtime !== runtime || this.closed) return;
    if (method === "browsingContext.contextCreated") {
      runtime.parents.set(String(params.context), typeof params.parent === "string" ? params.parent : null);
      if (this.page.options.network === "local" && params.parent === null && this.page.state && params.context !== this.page.state.context) {
        void runtime.bidi.request("browsingContext.close", { context: params.context }, 2_000).catch(error => {
          if (!this.closed) this.page.report(error as Error);
        });
      }
    }
    this.page.receive(runtime, method, params);
    if (method === "browsingContext.contextDestroyed") runtime.parents.delete(String(params.context));
  }

  belongs(runtime: FirefoxRuntime, context: string, root: string): boolean {
    let current: string | null | undefined = context;
    while (current) {
      if (current === root) return true;
      current = runtime.parents.get(current);
    }
    return false;
  }

  private invalidate(): FirefoxRuntime | undefined {
    const runtime = this.runtime;
    this.runtime = undefined;
    this.page.invalidate();
    return runtime;
  }

  private async stop(runtime: FirefoxRuntime): Promise<void> {
    // Graceful close flushes Firefox's profile before the generic bounded stop.
    const child = runtime.process.child;
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
      await Promise.race([runtime.bidi.request("browser.close", {}, 1_000).then(() => exited), delay(1_000)]).catch(() => {});
    }
    runtime.bidi.close();
    await this.launcher.stop(runtime.process);
  }

  private async initialize(): Promise<void> {
    if (this.closed || this.page.closed || this.stopping) throw new Error("The controlled browser is closed or stopping");
    const process = await this.launcher.start();
    let bidi: Bidi | undefined;
    let runtime: FirefoxRuntime | undefined;
    try {
      const deadline = Date.now() + 15_000;
      bidi = await Bidi.connect(process.endpoint, 15_000);
      const connection = bidi;
      const request = (method: string, params: BidiObject = {}) => connection.request(method, params, Math.max(1, deadline - Date.now()));
      await request("session.new", { capabilities: {} });
      const tree = await request("browsingContext.getTree");
      const initial = Array.isArray(tree.contexts) ? tree.contexts.map(object).find(context => context.parent === null && context.url === "about:blank") : undefined;
      if (typeof initial?.context !== "string") throw new Error("Owned Firefox has no initial page context");
      if (this.closed || this.page.closed) throw new Error("The controlled browser is closed");
      runtime = { process, bidi, parents: new Map([[initial.context, null]]) };
      this.runtime = runtime;
      const current = runtime;
      bidi.onEvent((method, params) => this.receive(current, method, params));
      process.child.once("exit", () => {
        if (!this.closed && this.runtime === current) {
          this.invalidate();
          this.page.report(new Error("The controlled Firefox process exited; restart pagent to restore the saved page"));
          if (!this.page.closed) this.humanClosed();
        }
      });
      await request("session.subscribe", { events: ["browsingContext.contextCreated", "browsingContext.contextDestroyed", "script.realmCreated", "script.realmDestroyed", "script.message", "log.entryAdded", "network.beforeRequestSent"] });
      await this.page.attach(current, initial.context);
    } catch (error) {
      if (this.runtime === runtime) this.invalidate();
      if (runtime) await this.stop(runtime);
      else { bidi?.close(); await this.launcher.stop(process); }
      throw error;
    }
  }

  reset(runtime: FirefoxRuntime, restart: boolean): Promise<void> {
    // Concurrent page operations join one recovery rather than restarting again.
    if (this.recovery) return this.recovery;
    if (this.runtime !== runtime || this.closed) return Promise.resolve();
    this.invalidate();
    const stopped = this.stop(runtime);
    const recovery = this.operation(async () => {
      await stopped;
      if (restart && !this.closed && !this.page.closed && !this.stopping) await this.initialize();
    });
    this.recovery = recovery;
    void recovery.finally(() => { if (this.recovery === recovery) this.recovery = undefined; }).catch(() => {});
    return recovery;
  }

  reload(): Promise<void> {
    return this.operation(async () => {
      if (this.closed || this.page.closed || this.stopping) throw new Error("The controlled browser is closed or stopping");
      if (!this.runtime) await this.initialize();
      else await this.page.navigate();
    });
  }

  humanClosed(): void {
    this.page.markClosed();
    this.page.options.onClose?.();
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const runtime = this.runtime;
    this.runtime = undefined;
    this.page.markClosed();
    this.closing = (async () => {
      if (runtime) await this.stop(runtime);
      // Interrupt startup without waiting on the serialized lifecycle queue.
      await this.launcher.close();
      await this.lifecycle;
    })();
    return this.closing;
  }
}
