#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startPagent, type PagentApp } from "./app.ts";
import { detectBrowser } from "./browser-default.ts";
import { formatBrowserLog } from "./terminal.ts";

const HELP = `pagent — the browser tab is the agent workspace

Usage: pagent [directory] [options]

Opens directory/index.html in a controlled browser window. The directory defaults
to the current directory. A missing index.html is created from the starter template.
An existing document must contain a <p-agent> element.

  --model <provider/model[:thinking]>  Override Pi's saved default or gpt-6-astra
  --thinking <level>                   off|minimal|low|medium|high|xhigh|max
  --port <number>                      HTTP port (default 0: choose a free port)
  --headless                          No visible window (automation)
  --browser <chromium|firefox>         Default: installed Firefox, otherwise Chromium
  --chromium <executable>              Chromium binary (CHROMIUM_BINARY also supported)
  --firefox <executable>               Firefox binary (FIREFOX_BINARY also supported)
  --no-sandbox                        Chromium only: disable browser sandbox; unsafe
  --restore <revision.html|latest>     Restore a saved HTML checkpoint before opening
  --reset-ui                          Back up and replace all starter UI files
  --help                              Show this help

Run pi and use /login to authenticate before starting Pagent. Pi's saved default
model is used when set; otherwise gpt-6-astra. Override it with --model.
Use the controlled browser window; manually opened tabs have no agent connection.
Private runtime state stays in directory/.pagent/ and is never HTTP-served.
Save checkpoints the live document; Reload discards unsaved DOM/runtime state.
Ctrl+C saves the document and stops the browser. Console diagnostics go to stdout.
`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
    model: { type: "string" }, thinking: { type: "string" }, port: { type: "string" },
    headless: { type: "boolean" }, browser: { type: "string" },
    chromium: { type: "string" }, firefox: { type: "string" },
    "no-sandbox": { type: "boolean" }, restore: { type: "string" },
    "reset-ui": { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.help) { console.log(HELP); return; }
  if (positionals.length > 1) throw new Error("Specify at most one directory. See --help.");
  const browser = values.browser ?? await detectBrowser();
  if (browser !== "chromium" && browser !== "firefox") throw new Error("Unsupported browser. Use --browser chromium or --browser firefox.");
  if (browser === "firefox" && (values.chromium || values["no-sandbox"])) throw new Error("--chromium and --no-sandbox are Chromium-only. Use --browser chromium to select Chromium.");
  if (browser === "chromium" && values.firefox) throw new Error("Use --browser firefox with --firefox.");
  const port = values.port === undefined ? 0 : Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be an integer from 0 through 65535.");
  if (values["no-sandbox"]) console.error("Warning: Chromium's process sandbox is explicitly disabled.");
  let app: PagentApp | undefined;
  const startup = new AbortController();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    startup.abort(new Error("Startup cancelled."));
    void app?.close().then(() => { process.exitCode = 0; }, error => { console.error(error); process.exitCode = 1; });
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    app = await startPagent({
      directory: positionals[0], port, model: values.model, thinking: values.thinking,
      headless: values.headless, browser,
      executable: browser === "firefox" ? values.firefox : values.chromium,
      noSandbox: values["no-sandbox"], restore: values.restore, resetUI: values["reset-ui"], signal: startup.signal,
      onConsole: entry => { process.stdout.write(formatBrowserLog(entry) + "\n"); },
    });
  } catch (error) {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    if (stopping) return;
    throw error;
  }
  if (stopping) { await app.close(); return; }
  console.log(`Pagent: ${app.url}\nBrowser: ${browser}\nModel: ${app.modelLabel}\nFiles: ${app.directory}\nUse the controlled browser window. Ctrl+C saves and stops.`);
}

main().catch(error => {
  console.error(`pagent: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
