import { resourcePath } from "./storage.ts";

export interface PromptSource { kind: "raw" | "url" | "el"; value: string }
export const MAX_PROMPT_BYTES = 128 * 1024;

export function promptText(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > MAX_PROMPT_BYTES) throw new Error("Prompt text must be nonempty and at most 128 KiB.");
  return value;
}

export function promptSource(value: unknown): PromptSource {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["kind", "value"].includes(key)) || !("kind" in value) || !("value" in value)) throw new Error("Prompt source requires {kind: raw|url|el, value: string}.");
  const kind = value.kind;
  if (kind !== "raw" && kind !== "url" && kind !== "el") throw new Error("Prompt source kind must be raw, url, or el.");
  const text = promptText(value.value);
  return { kind, value: kind === "url" ? promptResource(text) : text };
}

export const TOOL_NAMES = ["console", "save", "reload", "wait", "web_search", "web_fetch", "web_read"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type ExecutionState = "armed" | "running" | "pausing" | "paused" | "stopped";
export type CheckpointPolicy = "document" | "private" | "none";

/** Declarative settings are captured once for each attached identity. */
export interface AgentConfiguration {
  model?: string;
  systemPromptSource?: PromptSource;
  tools?: ToolName[];
  mode?: "continuous";
  repeatPromptSource?: PromptSource;
  repeatDelayMs?: number;
}

export function toolNames(value: unknown): ToolName[] {
  if (!Array.isArray(value) || value.some(name => typeof name !== "string" || !TOOL_NAMES.some(known => known === name))) {
    throw new Error(`Tools must be selected from: ${TOOL_NAMES.join(", ")}.`);
  }
  if (new Set(value).size !== value.length) throw new Error("Duplicate tool names are not allowed.");
  return value as ToolName[];
}

export function promptResource(value: string): string {
  if (!value || value.startsWith("/") || value.includes(":") || value.startsWith("\\")) throw new Error("Prompt URL must be a relative local resource path.");
  const relative = value.startsWith("./") ? value.slice(2) : value;
  resourcePath(relative);
  return relative;
}

export function agentConfiguration(value: unknown): AgentConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent configuration.");
  const configuration: AgentConfiguration = {};
  for (const key of Object.keys(value)) {
    if (key === "systemPrompt" || key === "repeatPrompt") throw new Error(`${key} was removed; use ${key}Source with {kind: raw|url|el, value}.`);
    if (!["agentId", "model", "systemPromptSource", "tools", "mode", "repeatPromptSource", "repeatDelayMs"].includes(key)) throw new Error(`Unknown agent setting: ${key}`);
  }
  if ("model" in value) {
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 500) throw new Error("model must be a nonempty model ID.");
    configuration.model = value.model;
  }
  if ("systemPromptSource" in value) configuration.systemPromptSource = promptSource(value.systemPromptSource);
  if ("tools" in value) configuration.tools = toolNames(value.tools);
  if ("mode" in value) {
    if (value.mode !== "continuous") throw new Error("The supported mode is continuous; omit mode for manual execution.");
    configuration.mode = value.mode;
  }
  if ("repeatPromptSource" in value) configuration.repeatPromptSource = promptSource(value.repeatPromptSource);
  if ("repeatDelayMs" in value) {
    if (typeof value.repeatDelayMs !== "number" || !Number.isSafeInteger(value.repeatDelayMs) || value.repeatDelayMs < 0 || value.repeatDelayMs > 2_147_483_647) throw new Error("repeat-delay must be milliseconds from 0 through 2147483647.");
    configuration.repeatDelayMs = value.repeatDelayMs;
  }
  if (configuration.mode === "continuous" && !configuration.repeatPromptSource) throw new Error("Continuous agents require a repeat-prompt-raw, repeat-prompt-url, or repeat-prompt-el source.");
  return configuration;
}

export function effectiveTools(configuration: AgentConfiguration, ceiling: ToolName[], network: "open" | "local", checkpoint: CheckpointPolicy): ToolName[] {
  const selected = configuration.tools ?? ceiling;
  if (selected.some(name => !ceiling.includes(name))) throw new Error("Agent tools exceed the host's allowed tools.");
  return selected.filter(name => !(network === "local" && name.startsWith("web_")) && !(checkpoint === "none" && name === "save"));
}
