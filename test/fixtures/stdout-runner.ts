import { startPagent, type PagentApp } from "../../src/app.ts";
import { formatBrowserLog } from "../../src/terminal.ts";

// Only this test executable enables the local faux provider. The installed CLI
// always uses the user's authenticated Pi model.
const [directory, browser] = process.argv.slice(2);
if (!directory || (browser !== "chromium" && browser !== "firefox")) throw new Error("Expected a directory and browser engine.");
const startup = new AbortController();
let app: PagentApp | undefined;
let stopping = false;
process.once("SIGTERM", () => {
  stopping = true;
  startup.abort(new Error("Test runner stopped."));
  void app?.close().catch(error => { console.error(error); process.exitCode = 1; });
});
try {
  app = await startPagent({ directory, browser, headless: true, port: 0, fake: true,
    noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1",
    signal: startup.signal,
    onConsole: entry => { process.stdout.write(formatBrowserLog(entry) + "\n"); },
  });
  if (stopping) await app.close();
} catch (error) {
  if (!stopping) throw error;
}
