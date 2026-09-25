import { BrowserProcessLauncher } from "pi-browser";
import { FirefoxProcess } from "./firefox-process.ts";
import { validateBrowserPolicy } from "./browser-policy.ts";
import type { BrowserOptions, PageBrowser } from "./protocol.ts";

export async function launchFirefox(options: BrowserOptions): Promise<PageBrowser> {
  validateBrowserPolicy(options);
  const launcher = await BrowserProcessLauncher.create({ ...options, browser: "firefox" });
  const browser = new FirefoxProcess(options, launcher);
  try { await browser.start(); return browser.page; }
  catch (error) { await browser.close(); throw error; }
}
