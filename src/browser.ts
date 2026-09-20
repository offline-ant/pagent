import { launchChromium } from "./chromium.ts";
import { launchFirefox } from "./firefox.ts";
import type { BrowserOptions, PageBrowser } from "./protocol.ts";

export function launchBrowser(options: BrowserOptions): Promise<PageBrowser> {
  switch (options.browser ?? "chromium") {
    case "chromium": return launchChromium(options);
    case "firefox": return launchFirefox(options);
    default: throw new Error("Unsupported browser. Use chromium or firefox.");
  }
}
