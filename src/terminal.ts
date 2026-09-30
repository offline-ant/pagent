import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { stripVTControlCharacters } from "node:util";
import type { BrowserLog } from "./protocol.ts";

/** Host-terminal input only; never expose these commands through the page bridge. */
export function installOperatorControls(
  app: { continue(): Promise<void>; close(): Promise<void> },
  options: { input?: Readable; output?: Writable } = {},
): () => void {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stdout;
  const lines = createInterface({ input, terminal: false, crlfDelay: Infinity });
  let disposed = false;
  let continuing = false;
  const report = (text: string) => { output.write(`${stripVTControlCharacters(text)}\n`); };
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    lines.close();
    // Node can keep a paused stdin pipe referenced after readline closes. Release
    // that default operator handle without destroying the caller's input stream.
    if (input === process.stdin && typeof process.stdin.unref === "function") process.stdin.unref();
  };
  const onError = (error: Error) => { report(`Operator input: ${error.message}`); dispose(); };
  lines.on("error", onError);
  lines.on("line", (line: string) => {
    if (disposed) return;
    const command = line.trim();
    if (!command) return;
    if (command === "finish") {
      // Finish must not wait behind a continuation that is still settling.
      dispose();
      void app.close().catch(error => report(`Finish failed: ${String(error)}`));
    } else if (command === "continue") {
      if (continuing) { report("Continuation already in progress."); return; }
      continuing = true;
      void app.continue().then(() => {
        if (!disposed) report("Continued execution for another interval.");
      }, error => report(`Continue failed: ${String(error)}`)).finally(() => { continuing = false; });
    } else report("Operator commands: continue (after deadline pause), finish.");
  });
  lines.once("close", () => { disposed = true; });
  report("Operator commands: continue (after deadline pause), finish. Ctrl+C also finishes.");
  return dispose;
}

export function formatBrowserLog(entry: BrowserLog): string {
  const location = entry.url ? ` (${entry.url}${entry.line === undefined ? "" : `:${entry.line}`}${entry.column === undefined ? "" : `:${entry.column}`})` : "";
  const showStack = entry.source === "exception" || ["error", "assert", "trace"].includes(entry.method ?? entry.level);
  const stack = showStack && entry.stack && !entry.text.includes(entry.stack) ? `\n${entry.stack}` : "";
  return stripVTControlCharacters(`[browser ${entry.source}.${entry.method ?? entry.level}]${location} ${entry.text}${stack}`);
}
