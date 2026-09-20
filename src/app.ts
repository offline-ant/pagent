import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";
import { detectBrowser } from "./browser-default.ts";
import { recoverWorkspace } from "./recovery.ts";
import { startServer, type ResourceServer } from "./server.ts";
import { startSession, type PagentSession } from "./session.ts";
import { openWorkspace } from "./storage.ts";
import type { BrowserKind, BrowserLog, PageBrowser } from "./protocol.ts";

export type { PagentSession } from "./session.ts";

export interface PagentOptions {
  directory?: string;
  port?: number;
  model?: string;
  thinking?: string;
  /** Internal deterministic provider for tests; not a CLI option. */
  fake?: boolean;
  headless?: boolean;
  browser?: BrowserKind;
  executable?: string;
  noSandbox?: boolean;
  restore?: string;
  resetUI?: boolean;
  log?: (message: string) => void;
  onConsole?: (entry: BrowserLog) => void;
  signal?: AbortSignal;
}

export type PagentApp = PagentSession;

/** One directory, one controlled page, one listener and browser process. */
export async function startPagent(options: PagentOptions = {}): Promise<PagentApp> {
  const log = options.log ?? console.error;
  const templateDir = fileURLToPath(new URL("../template/", import.meta.url));
  options.signal?.throwIfAborted();
  const workspace = await openWorkspace({ directory: options.directory ?? process.cwd(), templateDir });
  const startup = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, startup.signal]) : startup.signal;
  let server: ResourceServer | undefined;
  let browser: PageBrowser | undefined;
  let session: PagentSession | undefined;
  let closing: Promise<void> | undefined;

  function close(): Promise<void> {
    if (closing) return closing;
    startup.abort(new Error("Pagent is shutting down."));
    closing = (async () => {
      const errors: unknown[] = [];
      for (const operation of [() => session?.close(), () => browser?.close(), () => server?.close(), () => workspace.close()]) {
        try { await operation(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Pagent cleanup failed");
    })();
    return closing;
  }

  try {
    const browserKind = options.browser ?? await detectBrowser();
    if (browserKind !== "chromium" && browserKind !== "firefox") throw new Error("Unsupported browser. Use chromium or firefox.");
    if (browserKind === "firefox" && options.noSandbox) throw new Error("--no-sandbox is Chromium-only; Firefox sandboxing remains enabled.");
    await recoverWorkspace(workspace, templateDir, { restore: options.restore, resetUI: options.resetUI, log });
    signal.throwIfAborted();
    server = await startServer(workspace, { port: options.port });
    session = await startSession({
      workspace, url: server.url, browserKind, model: options.model, thinking: options.thinking,
      fake: options.fake, signal, webHeadless: options.headless, log, onConsole: options.onConsole,
      createBrowser: async tabOptions => {
        browser = await launchBrowser({ ...tabOptions, browser: browserKind,
          profileDir: path.join(workspace.stateDirectory, browserKind), headless: options.headless ?? false,
          executable: options.executable, noSandbox: options.noSandbox });
        return browser;
      },
      onClose: () => { void close().catch(error => log(String(error))); },
    });
    const connected = session;
    return { ...connected, get busy() { return connected.busy; }, close };
  } catch (error) {
    await close().catch(failure => log(String(failure)));
    throw error;
  }
}
