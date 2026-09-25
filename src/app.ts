import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchBrowser } from "./browser.ts";
import { detectBrowser } from "./browser-default.ts";
import { validateConfiguration, type PagentConfiguration } from "./config.ts";
import { DomRecorder } from "./recording.ts";
import { recoverWorkspace } from "./recovery.ts";
import { startServer, type ResourceServer } from "./server.ts";
import { startSession, type PagentSession } from "./session.ts";
import { openWorkspace } from "./storage.ts";
import type { BrowserLog, PageBrowser } from "./protocol.ts";

export type { PagentSession } from "./session.ts";

export interface PagentOptions extends PagentConfiguration {
  directory?: string;
  port?: number;
  /** Internal deterministic provider for tests; not a CLI option. */
  fake?: boolean;
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
  const config = validateConfiguration({
    model: options.model, thinking: options.thinking, browser: options.browser, headless: options.headless,
    tools: options.tools, http: options.http, network: options.network, checkpoint: options.checkpoint,
    durationMs: options.durationMs, repeatDelayMs: options.repeatDelayMs, record: options.record, viewport: options.viewport,
  });
  const templateDir = fileURLToPath(new URL("../template/", import.meta.url));
  options.signal?.throwIfAborted();
  const workspace = await openWorkspace({ directory: options.directory ?? process.cwd(), templateDir });
  const startup = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, startup.signal]) : startup.signal;
  let server: ResourceServer | undefined;
  let browser: PageBrowser | undefined;
  let session: PagentSession | undefined;
  let closing: Promise<void> | undefined;
  let recorder: DomRecorder | undefined;

  function close(): Promise<void> {
    if (closing) return closing;
    startup.abort(new Error("Pagent is shutting down."));
    closing = (async () => {
      const errors: unknown[] = [];
      for (const operation of [() => session ? session.close() : recorder?.stop(), () => browser?.close(), () => server?.close(), () => workspace.close()]) {
        try { await operation(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, "Pagent cleanup failed");
    })();
    return closing;
  }

  try {
    const browserKind = config.browser ?? await detectBrowser();
    if (browserKind !== "chromium" && browserKind !== "firefox") throw new Error("Unsupported browser. Use chromium or firefox.");
    if (browserKind === "firefox" && options.noSandbox) throw new Error("--no-sandbox is Chromium-only; Firefox sandboxing remains enabled.");
    await recoverWorkspace(workspace, templateDir, { restore: options.restore, resetUI: options.resetUI, log });
    signal.throwIfAborted();
    server = await startServer(workspace, { port: options.port, http: config.http, network: config.network });
    session = await startSession({
      workspace, url: server.url, browserKind, model: config.model, thinking: config.thinking,
      tools: config.tools, http: config.http, network: config.network, checkpoint: config.checkpoint,
      durationMs: config.durationMs, repeatDelayMs: config.repeatDelayMs,
      fake: options.fake, signal, webHeadless: config.headless, log, onConsole: options.onConsole,
      onExecutionStart: async () => {
        if (recorder) { await recorder.start(); log(`Recording: ${recorder.directory}`); }
      },
      onRecordingEvent: record => recorder?.observe(record),
      onRecordingInvalidated: () => recorder?.disableEvents(),
      onExecutionStop: async () => {
        await recorder?.stop();
        // Do not await close here: session cleanup itself joins this stop hook.
        if (!closing) setImmediate(() => { void close().catch(error => log(String(error))); });
      },
      createBrowser: async tabOptions => {
        browser = await launchBrowser({ ...tabOptions, browser: browserKind, network: config.network, viewport: config.viewport,
          profileDir: path.join(workspace.stateDirectory, browserKind), headless: config.headless ?? false,
          executable: options.executable, noSandbox: options.noSandbox });
        if (config.record) recorder = new DomRecorder({ ...config.record, stateDirectory: workspace.stateDirectory, browser, log });
        return browser;
      },
      onClose: () => { void close().catch(error => log(String(error))); },
    });
    const connected = session;
    return { ...connected, get busy() { return connected.busy; }, get executionState() { return connected.executionState; }, close };
  } catch (error) {
    await close().catch(failure => log(String(failure)));
    throw error;
  }
}
