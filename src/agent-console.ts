import type { HostEvent } from "./protocol.ts";

export interface AgentConsoleEntry {
  level: "log" | "info" | "debug" | "error";
  text: string;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(block => {
    const part = record(block);
    if (part.type === "text") return String(part.text ?? "");
    if (part.type === "image") return `[image: ${String(part.mimeType ?? "unknown")}]`;
    return "";
  }).filter(Boolean).join("\n");
}

/** Completed text is printed once, not as thousands of repeated partial snapshots. */
export function agentConsoleEntries({ seq, agentId, requestId, event }: HostEvent): AgentConsoleEntry[] {
  const entries: AgentConsoleEntry[] = [];
  const add = (level: AgentConsoleEntry["level"], label: string, text: string) => {
    entries.push({ level, text: `[pagent ${label} #${seq}${agentId ? ` agent=${agentId}` : ""}${requestId ? ` ${requestId}` : ""}] ${text}` });
  };
  switch (event.type) {
    case "message": {
      if (event.phase !== "end") break;
      const message = record(event.message);
      if (message.role === "user") add("log", "user", contentText(message.content));
      if (message.role !== "assistant") break;
      const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
      for (const value of blocks) {
        const block = record(value);
        if (block.type === "text" && typeof block.text === "string" && block.text) add("log", "assistant", block.text);
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) add("debug", "reasoning", block.thinking);
      }
      if (typeof message.errorMessage === "string" && message.errorMessage) add("error", "assistant error", message.errorMessage);
      break;
    }
    case "tool": {
      if (event.phase === "start") add("info", `tool ${event.name} ${event.callId}`, JSON.stringify(event.args));
      if (event.phase === "end") {
        const result = record(event.result);
        const summary = Array.isArray(result.content) ? { ...result, content: result.content.map(value => {
          const block = record(value);
          return block.type === "image" ? { type: "image", mimeType: block.mimeType, data: "[image bytes omitted from console mirror]" } : value;
        }) } : event.result;
        add(event.isError ? "error" : "log", `tool result ${event.name} ${event.callId}`, JSON.stringify(summary));
      }
      break;
    }
    case "web-attention":
      if (event.request) add("info", "web attention", `${event.request.reason} ${event.request.url} (tab ${event.request.tab})`);
      break;
    case "web-progress": add("info", "web", event.message); break;
    case "error": add("error", "error", event.message); break;
    case "status": add("info", "status", event.status); break;
    case "saved": add("debug", "saved", event.revision); break;
    case "connected": add("info", "connected", `${event.url} ${event.model}${event.busy ? " (running)" : ""}`); break;
  }
  return entries;
}
