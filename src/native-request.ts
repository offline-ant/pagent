import { isWebBackend } from "pi-browser/web";
import { MAX_AGENTS, validateAgentId } from "./runs.ts";
import type { AgentDescriptor, NativeRequest } from "./protocol.ts";
import { agentConfiguration } from "./agent-config.ts";

export function nativeRequest(value: unknown): NativeRequest {
  if (!value || typeof value !== "object" || !("type" in value)) throw new Error("Invalid native request.");
  if (value.type === "ready") {
    if (!("after" in value) || typeof value.after !== "number" || !Number.isSafeInteger(value.after) || value.after < 0) throw new Error("Invalid replay cursor.");
    if (!("agents" in value) || !Array.isArray(value.agents) || value.agents.length > MAX_AGENTS) throw new Error(`Ready requires at most ${MAX_AGENTS} unique agent IDs.`);
    const agents: AgentDescriptor[] = [];
    for (const item of value.agents) {
      if (!item || typeof item !== "object" || !("agentId" in item)) throw new Error("Ready agents must be configuration descriptors with agentId.");
      validateAgentId(item.agentId);
      agents.push({ agentId: item.agentId, ...agentConfiguration(item) });
    }
    if (new Set(agents.map(agent => agent.agentId)).size !== agents.length) throw new Error("Duplicate agent IDs in ready request.");
    return { type: "ready", after: value.after, agents };
  }
  if (value.type === "submit" || value.type === "register" || value.type === "dispose" || value.type === "cancel" || value.type === "web-continue" || value.type === "web-cancel") {
    if (!("agentId" in value)) throw new Error("This request requires an agentId.");
    validateAgentId(value.agentId);
    if (value.type === "register") {
      const { type: _type, ...descriptor } = value;
      return { type: "register", agentId: value.agentId, ...agentConfiguration(descriptor) };
    }
    if (value.type === "dispose" || value.type === "cancel") return { type: value.type, agentId: value.agentId };
    if (!("id" in value)) throw new Error("This request requires an input/attention ID.");
    validateAgentId(value.id);
    if (value.type !== "submit") return { type: value.type, agentId: value.agentId, id: value.id };
    if (!("runId" in value)) throw new Error("Submission requires a unique runId.");
    validateAgentId(value.runId);
    if ("scheduleId" in value) validateAgentId(value.scheduleId);
    return { type: "submit", agentId: value.agentId, id: value.id, runId: value.runId,
      ...("scheduleId" in value ? { scheduleId: value.scheduleId as string } : {}) };
  }
  if (value.type === "backend-set") {
    if (!("override" in value) || value.override !== null && !isWebBackend(value.override)) throw new Error("Web backend override must be auto, codex, browser, or null (Use default).");
    return { type: "backend-set", override: value.override };
  }
  if (value.type === "save" || value.type === "reload" || value.type === "start" || value.type === "nudge" || value.type === "stop") return { type: value.type };
  throw new Error("Unsupported native request.");
}
