// Workspace ownership; native process/transport mechanics live in pi-browser.
import { setTimeout as delay } from "node:timers/promises";
import { BrowserProcessLauncher, type NativeBrowserProcess } from "pi-browser";
import { Cdp, object, type CdpObject } from "pi-browser/cdp";
import { ChromiumPage } from "./chromium-page.ts";
import { validateBrowserPolicy } from "./browser-policy.ts";
import type { BrowserOptions, BrowserPageOptions, PageBrowser } from "./protocol.ts";

/** Only the controlled page receives the workspace bridge. */
export class ChromiumBrowser {
  private launcher: BrowserProcessLauncher;
  private cdp: Cdp;
  private port: string;
  private page?: ChromiumPage;
  private closed = false;
  private closing?: Promise<void>;

  constructor(launcher: BrowserProcessLauncher, runtime: NativeBrowserProcess, cdp: Cdp) {
    this.launcher = launcher;
    this.cdp = cdp;
    this.port = new URL(runtime.endpoint).port;
    cdp.onEvent((method, params) => {
      if (method === "Target.targetDestroyed" && params.targetId === this.page?.targetId) this.page?.dispose(!this.closed);
    });
    runtime.child.once("exit", () => {
      if (this.closed) return;
      this.closed = true;
      this.page?.dispose(true, new Error("The controlled Chromium process exited; restart pagent to restore the saved page"));
      this.cdp.close();
    });
  }

  async initialize(options: BrowserPageOptions): Promise<ChromiumPage> {
    const deadline = Date.now() + 15_000;
    let target: CdpObject | undefined;
    while (Date.now() < deadline) {
      if (this.closed) throw new Error("The controlled browser is closed");
      const response = await fetch(`http://127.0.0.1:${this.port}/json/list`, { signal: AbortSignal.timeout(5_000) });
      const targets: unknown = await response.json();
      if (!Array.isArray(targets)) throw new Error("Chromium did not return its targets");
      target = targets.map(object).find(page => page.type === "page" && page.url === "about:blank");
      if (typeof target?.id === "string") break;
      await delay(25);
    }
    if (typeof target?.id !== "string" || typeof target.webSocketDebuggerUrl !== "string") throw new Error("Owned Chromium has no initial page debugging socket");
    const connection = await Cdp.connect(target.webSocketDebuggerUrl);
    if (this.closed) { connection.close(); throw new Error("The controlled browser is closed"); }
    this.page = new ChromiumPage(options, this, connection, target.id);
    if (options.network === "local") {
      const controlled = target.id;
      this.cdp.onEvent((method, params) => {
        if (method !== "Target.attachedToTarget" || this.closed) return;
        const attached = object(params.targetInfo);
        // Pause new top-level pages before their scripts/network activity, then
        // close them. This is convenience confinement, not an OS sandbox.
        const operation = attached.targetId === controlled
          ? this.cdp.request("Runtime.runIfWaitingForDebugger", {}, 2_000, String(params.sessionId))
          : this.cdp.request("Target.closeTarget", { targetId: attached.targetId }, 2_000);
        void operation.catch(error => { if (!this.closed) options.onError?.(error as Error); });
      });
      await this.cdp.request("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true,
        filter: [{ type: "page", exclude: false }, { exclude: true }] });
      await this.cdp.request("Browser.setDownloadBehavior", { behavior: "deny" });
    }
    await this.page.initialize();
    return this.page;
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    this.closed = true;
    this.page?.dispose(false);
    this.cdp.close();
    await this.launcher.close();
  }
}

export async function launchChromium(options: BrowserOptions): Promise<PageBrowser> {
  validateBrowserPolicy(options);
  const url = new URL(options.url);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Workspace URL must use HTTP or HTTPS");
  const launcher = await BrowserProcessLauncher.create({ ...options, browser: "chromium", chromiumArgs: ["--no-proxy-server"] });
  let cdp: Cdp | undefined;
  let browser: ChromiumBrowser | undefined;
  try {
    const runtime = await launcher.start();
    cdp = await Cdp.connect(runtime.endpoint);
    browser = new ChromiumBrowser(launcher, runtime, cdp);
    await cdp.request("Target.setDiscoverTargets", { discover: true });
    return await browser.initialize(options);
  } catch (error) {
    if (browser) await browser.close();
    else { cdp?.close(); await launcher.close(); }
    throw error;
  }
}
