import { readFile } from "node:fs/promises";
import type { BrowserKind } from "./protocol.ts";
import { toolNames } from "./agent-config.ts";
import { validateBrowserPolicy } from "./browser-policy.ts";
import type { RecordingEventKind } from "./recording.ts";

/** Explicit host configuration. Never discovered from the working directory. */
export interface PagentConfiguration {
  model?: string;
  thinking?: string;
  browser?: BrowserKind;
  headless?: boolean;
  tools?: string[];
  http?: string[];
  network?: "open" | "local";
  checkpoint?: "document" | "private" | "none";
  durationMs?: number;
  deadlinePolicy?: "close" | "pause";
  repeatDelayMs?: number;
  record?: { intervalMs: number; screenshots?: boolean; events?: RecordingEventKind[] };
  viewport?: { width: number; height: number };
}

const KEYS = new Set(["model", "thinking", "browser", "headless", "tools", "http", "network", "checkpoint", "durationMs", "deadlinePolicy", "repeatDelayMs", "record", "viewport"]);
const HTTP = new Set(["GET", "HEAD", "POST", "PUT", "DELETE"]);

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: Set<string>, name: string): void {
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`Unknown ${name} option: ${key}.`);
}

function integer(value: unknown, name: string, minimum = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > 2_147_483_647) {
    throw new Error(`${name} must be an integer from ${minimum} through 2147483647.`);
  }
  return value;
}

function strings(value: unknown, allowed: Set<string>, name: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== "string" || !allowed.has(item))) {
    throw new Error(`${name} must be an array containing only ${[...allowed].join(", ")}.`);
  }
  if (new Set(value).size !== value.length) throw new Error(`${name} must not contain duplicates.`);
  return [...value];
}

export function validateConfiguration(input: unknown): PagentConfiguration {
  const value = object(input, "Configuration");
  keys(value, KEYS, "configuration");
  const result: PagentConfiguration = {};
  for (const key of ["model", "thinking"] as const) {
    if (value[key] === undefined) continue;
    if (typeof value[key] !== "string" || !value[key].trim()) throw new Error(`${key} must be a nonempty string.`);
    result[key] = value[key];
  }
  if (value.browser !== undefined) {
    if (value.browser !== "chromium" && value.browser !== "firefox") throw new Error("Unsupported browser. Use chromium or firefox.");
    result.browser = value.browser;
  }
  if (value.headless !== undefined) {
    if (typeof value.headless !== "boolean") throw new Error("headless must be a boolean.");
    result.headless = value.headless;
  }
  if (value.tools !== undefined) result.tools = [...toolNames(value.tools)];
  if (value.http !== undefined) result.http = strings(value.http, HTTP, "http");
  if (value.network !== undefined) {
    if (value.network !== "open" && value.network !== "local") throw new Error("network must be open or local.");
    result.network = value.network;
  }
  if (value.checkpoint !== undefined) {
    if (!["document", "private", "none"].includes(String(value.checkpoint))) throw new Error("checkpoint must be document, private, or none.");
    result.checkpoint = value.checkpoint as PagentConfiguration["checkpoint"];
  }
  if (value.durationMs !== undefined) result.durationMs = integer(value.durationMs, "durationMs");
  if (value.deadlinePolicy !== undefined) {
    if (value.deadlinePolicy !== "close" && value.deadlinePolicy !== "pause") throw new Error("deadlinePolicy must be close or pause.");
    result.deadlinePolicy = value.deadlinePolicy;
  }
  if (result.deadlinePolicy === "pause" && result.durationMs === undefined) throw new Error("deadlinePolicy pause requires durationMs.");
  if (value.repeatDelayMs !== undefined) result.repeatDelayMs = integer(value.repeatDelayMs, "repeatDelayMs", 0);
  if (value.record !== undefined) {
    const record = object(value.record, "record");
    keys(record, new Set(["intervalMs", "screenshots", "events"]), "record");
    if (record.screenshots !== undefined && typeof record.screenshots !== "boolean") throw new Error("record.screenshots must be a boolean.");
    result.record = {
      intervalMs: integer(record.intervalMs, "record.intervalMs"),
      ...(record.screenshots === undefined ? {} : { screenshots: record.screenshots }),
      ...(record.events === undefined ? {} : { events: strings(record.events, new Set(["tool", "thinking", "message"]), "record.events") as RecordingEventKind[] }),
    };
  }
  if (value.viewport !== undefined) {
    const viewport = object(value.viewport, "viewport");
    keys(viewport, new Set(["width", "height"]), "viewport");
    result.viewport = { width: integer(viewport.width, "viewport.width"), height: integer(viewport.height, "viewport.height") };
  }
  validateBrowserPolicy(result);
  return result;
}

export async function readConfiguration(filename: string): Promise<PagentConfiguration> {
  let value: unknown;
  try { value = JSON.parse(await readFile(filename, "utf8")); }
  catch (error) { throw new Error(`Cannot read configuration ${filename}: ${error instanceof Error ? error.message : String(error)}`); }
  return validateConfiguration(value);
}
