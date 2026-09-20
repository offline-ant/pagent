import assert from "node:assert/strict";
import test from "node:test";
import { createContext, runInContext } from "node:vm";
import { agentConsoleEntries } from "../src/agent-console.ts";
import { deliveryExpression } from "../src/page-scripts.ts";
import { formatBrowserLog } from "../src/terminal.ts";
import type { HostEvent } from "../src/protocol.ts";

test("agent console mirrors completed content, tool activity and full errors, not repeated partials or provider metadata", () => {
  const message = { role: "assistant", content: [
    { type: "thinking", thinking: "Visible reasoning", thinkingSignature: "opaque-secret" },
    { type: "text", text: "The answer" },
  ], errorMessage: 'OAuth refresh failed: invalid_grant; Refresh token expired\n    at refresh (auth.js:6:12)' };
  assert.deepEqual(agentConsoleEntries({ seq: 1, event: { type: "message", phase: "update", message } }), []);
  const completed = agentConsoleEntries({ seq: 2, requestId: "p0", event: { type: "message", phase: "end", message } });
  assert.deepEqual(completed.map(entry => entry.level), ["debug", "log", "error"]);
  assert(completed[0].text.includes("Visible reasoning"));
  assert(completed[1].text.includes("The answer"));
  assert(completed[2].text.endsWith(message.errorMessage));
  assert(!JSON.stringify(completed).includes("opaque-secret"));
  assert.deepEqual(agentConsoleEntries({ seq: 3, event: { type: "message", phase: "end", message: { role: "toolResult", content: [] } } }), []);
  const result = { content: [{ type: "text", text: "x".repeat(20_000) }] };
  assert(agentConsoleEntries({ seq: 4, event: { type: "tool", phase: "end", callId: "c", name: "console", result } })[0].text.endsWith(JSON.stringify(result)));
});

test("snapshot image results remain native evidence but console mirrors omit base64", () => {
  const result = { content: [{ type: "text", text: "Snapshot: snap_test" }, { type: "image", mimeType: "image/png", data: "private-image-base64" }], details: { snapshot: "snap_test" } };
  const lines = agentConsoleEntries({ seq: 1, event: { type: "tool", phase: "end", callId: "image", name: "web_read", result } });
  assert.match(lines[0].text, /image\/png/);
  assert.match(lines[0].text, /Snapshot: snap_test/);
  assert(!lines[0].text.includes("private-image-base64"));
  assert.equal(result.content[1].data, "private-image-base64", "only the console mirror is changed");
});

test("web fallback and intervention diagnostics are visible without leaking host state", () => {
  const progress = agentConsoleEntries({ seq: 1, event: { type: "web-progress", message: "Codex unavailable; using browser." } });
  assert.equal(progress[0].level, "info");
  assert.match(progress[0].text, /Codex unavailable; using browser/);
  const attention = agentConsoleEntries({ seq: 2, event: { type: "web-attention", request: {
    id: "request-1", reason: "Complete the challenge", url: "https://example.com", tabId: "research-1",
  } } });
  assert.match(attention[0].text, /Complete the challenge https:\/\/example.com \(tab research-1\)/);
  assert.deepEqual(agentConsoleEntries({ seq: 3, event: { type: "web-attention", request: null } }), []);
});

test("browser delivery logs safely before UI dispatch and deduplicates repeated sequences per document", () => {
  const lines: string[] = [];
  const aos = new EventTarget();
  let received: unknown;
  aos.addEventListener("event", event => {
    const delivery = event as CustomEvent<HostEvent> & { ack(): void };
    received = delivery.detail;
    assert.equal(lines.length, 1);
    delivery.ack();
  });
  const print = (text: string) => lines.push(text);
  const context = createContext({ aos, CustomEvent, console: { log: print, info: print, debug: print, error: print } });
  const event: HostEvent = { seq: 10, event: { type: "error", message: '</script>\n"quoted"; globalThis.pwned=true' } };
  runInContext(deliveryExpression(event), context);
  runInContext(deliveryExpression(event), context);
  assert.equal(lines.length, 1);
  assert.equal(JSON.stringify(received), JSON.stringify(event));
  assert.equal(runInContext("typeof pwned", context), "undefined");
});

test("delivery requires synchronous acknowledgment, not a successful dispatch return", () => {
  let acknowledge: (() => void) | undefined;
  const context = createContext({
    CustomEvent,
    aos: { dispatchEvent(event: CustomEvent<HostEvent> & { ack(): void }) { acknowledge = event.ack; return true; } },
  });
  const event: HostEvent = { seq: 1, event: { type: "saved", revision: "revision" } };
  assert.throws(() => runInContext(deliveryExpression(event), context), /did not acknowledge/);
  acknowledge?.(); // A late ACK cannot turn a rejected delivery into success.
  assert.throws(() => runInContext(deliveryExpression(event), context), /did not acknowledge/);
});

test("terminal diagnostic formatting preserves locations and stacks without terminal control sequences", () => {
  const text = formatBrowserLog({ source: "exception", level: "error", text: '\u001b[31mPermission denied to access property "length"\u001b[0m',
    url: "http://example.aos.localhost:8080/", line: 6, column: 12, stack: "    at handler (agent.js:6:12)" });
  assert.match(text, /example\.aos\.localhost:8080\/:6:12/);
  assert.match(text, /Permission denied.*length/);
  assert.match(text, /at handler/);
  assert(!text.includes("\u001b"));
  assert.match(formatBrowserLog({ source: "console", level: "debug", method: "trace", text: "trace", stack: "    at caller" }), /console\.trace.*trace\n    at caller/s);
});
