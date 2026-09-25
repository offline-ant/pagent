import { resourcePath } from "./storage.ts";

export const TOOL_NAMES = ["console", "save", "reload", "wait", "web_search", "web_fetch", "web_read"] as const;
export type ToolName = typeof TOOL_NAMES[number];
export type ExecutionState = "armed" | "running" | "stopped";
export type CheckpointPolicy = "document" | "private" | "none";

/** Declarative settings are captured once for each attached identity. */
export interface AgentConfiguration {
  model?: string;
  systemPrompt?: string;
  tools?: ToolName[];
  mode?: "continuous";
  repeatPrompt?: string;
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
  if (!value || value.startsWith("/") || value.includes(":") || value.startsWith("\\")) throw new Error("system-prompt must be a relative local resource path.");
  const relative = value.startsWith("./") ? value.slice(2) : value;
  resourcePath(relative);
  return relative;
}

export function agentConfiguration(value: unknown): AgentConfiguration {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid agent configuration.");
  const configuration: AgentConfiguration = {};
  for (const key of Object.keys(value)) {
    if (!["agentId", "model", "systemPrompt", "tools", "mode", "repeatPrompt", "repeatDelayMs"].includes(key)) throw new Error(`Unknown agent setting: ${key}`);
  }
  if ("model" in value) {
    if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 500) throw new Error("model must be a nonempty model ID.");
    configuration.model = value.model;
  }
  if ("systemPrompt" in value) {
    if (typeof value.systemPrompt !== "string") throw new Error("system-prompt must be a local resource path.");
    configuration.systemPrompt = promptResource(value.systemPrompt);
  }
  if ("tools" in value) configuration.tools = toolNames(value.tools);
  if ("mode" in value) {
    if (value.mode !== "continuous") throw new Error("The supported mode is continuous; omit mode for manual execution.");
    configuration.mode = value.mode;
  }
  if ("repeatPrompt" in value) {
    if (typeof value.repeatPrompt !== "string" || !value.repeatPrompt.trim() || Buffer.byteLength(value.repeatPrompt) > 128 * 1024) throw new Error("repeat-prompt must be nonempty and at most 128 KiB.");
    configuration.repeatPrompt = value.repeatPrompt;
  }
  if ("repeatDelayMs" in value) {
    if (typeof value.repeatDelayMs !== "number" || !Number.isSafeInteger(value.repeatDelayMs) || value.repeatDelayMs < 0 || value.repeatDelayMs > 2_147_483_647) throw new Error("repeat-delay must be milliseconds from 0 through 2147483647.");
    configuration.repeatDelayMs = value.repeatDelayMs;
  }
  if (configuration.mode === "continuous" && !configuration.repeatPrompt) throw new Error("Continuous agents require repeat-prompt.");
  return configuration;
}

export function effectiveTools(configuration: AgentConfiguration, ceiling: ToolName[], network: "open" | "local", checkpoint: CheckpointPolicy): ToolName[] {
  const selected = configuration.tools ?? ceiling;
  if (selected.some(name => !ceiling.includes(name))) throw new Error("Agent tools exceed the host's allowed tools.");
  return selected.filter(name => !(network === "local" && name.startsWith("web_")) && !(checkpoint === "none" && name === "save"));
}
