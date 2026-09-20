import { inspect } from "node:util";
import { remoteValue as bidiValue } from "pi-browser/bidi";
import { object } from "pi-browser/cdp";
import type { BrowserLog } from "./protocol.ts";

function stackFrames(trace: unknown): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = [];
  // CDP may include asynchronous parent stacks; BiDi supplies just callFrames.
  for (let depth = 0; trace && depth < 8 && frames.length < 100; depth++) {
    const stack = object(trace);
    if (Array.isArray(stack.callFrames)) frames.push(...stack.callFrames.slice(0, 100 - frames.length).map(object));
    trace = stack.parent;
  }
  return frames;
}

/** Only the dedicated conversation mirror is synthetic. UI/context callbacks are real diagnostics. */
export function syntheticConsole(trace: unknown): boolean {
  return stackFrames(trace).some(frame => frame.url === "pagent-agent-mirror");
}

/** CDP Runtime and BiDi script stack coordinates are zero-based; display is one-based. */
export function logLocation(trace: unknown, fallback: Record<string, unknown> = {}): Pick<BrowserLog, "url" | "line" | "column" | "stack"> {
  const frames = stackFrames(trace);
  const first = frames[0] ?? fallback;
  const location = (frame: Record<string, unknown>) => ({
    ...(typeof frame.url === "string" && frame.url ? { url: frame.url } : {}),
    ...(typeof frame.lineNumber === "number" && frame.lineNumber >= 0 ? { line: frame.lineNumber + 1 } : {}),
    ...(typeof frame.columnNumber === "number" && frame.columnNumber >= 0 ? { column: frame.columnNumber + 1 } : {}),
  });
  const stack = frames.map(frame => {
    const source = location(frame);
    return `    at ${String(frame.functionName || "<anonymous>")} (${source.url ?? "<anonymous>"}${source.line === undefined ? "" : `:${source.line}`}${source.column === undefined ? "" : `:${source.column}`})`;
  }).join("\n");
  return { ...location(first), ...(stack ? { stack } : {}) };
}

/** Only inspect protocol data. Never call page functions, getters, or custom formatters. */
export function chromiumConsoleText(args: unknown): string {
  return (Array.isArray(args) ? args : []).map(arg => {
    const remote = object(arg);
    if ("value" in remote) return typeof remote.value === "string" ? remote.value : inspect(remote.value, { depth: 3, maxArrayLength: 20, maxStringLength: 2_000 }).slice(0, 8_000);
    if ("unserializableValue" in remote) return String(remote.unserializableValue);
    const preview = object(remote.preview);
    const properties = Array.isArray(preview.properties) ? preview.properties.slice(0, 20).map(item => {
      const property = object(item);
      return `${String(property.name)}: ${String(property.value ?? property.type)}`.slice(0, 2_000);
    }) : [];
    const description = String(remote.description ?? remote.subtype ?? remote.type ?? "unknown");
    // Error descriptions already include their message and stack.
    return (properties.length && remote.subtype !== "error"
      ? `${description} { ${properties.join(", ")}${preview.overflow ? ", …" : ""} }`
      : description).slice(0, 8_000);
  }).join(" ");
}

function bidiPreview(arg: unknown): string {
  const value = bidiValue(arg);
  return typeof value === "string" ? value : inspect(value, { depth: 3, maxArrayLength: 20, maxStringLength: 2_000, customInspect: false }).slice(0, 8_000);
}

export function firefoxConsoleText(params: Record<string, unknown>): string {
  const args = Array.isArray(params.args) ? params.args : [];
  // BiDi's native text preserves Error messages and console timer/count formatting.
  // Add a bounded data preview where native text only says Object(n)/Array(n).
  const previews = args.filter(arg => ["object", "array", "map", "set"].includes(String(object(arg).type))).map(bidiPreview);
  const text = typeof params.text === "string" ? params.text : args.map(bidiPreview).join(" ");
  return previews.length ? `${text}\n  ${previews.join("\n  ")}` : text;
}
