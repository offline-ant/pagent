import { stripVTControlCharacters } from "node:util";
import type { BrowserLog } from "./protocol.ts";

export function formatBrowserLog(entry: BrowserLog): string {
  const location = entry.url ? ` (${entry.url}${entry.line === undefined ? "" : `:${entry.line}`}${entry.column === undefined ? "" : `:${entry.column}`})` : "";
  const showStack = entry.source === "exception" || ["error", "assert", "trace"].includes(entry.method ?? entry.level);
  const stack = showStack && entry.stack && !entry.text.includes(entry.stack) ? `\n${entry.stack}` : "";
  return stripVTControlCharacters(`[browser ${entry.source}.${entry.method ?? entry.level}]${location} ${entry.text}${stack}`);
}
