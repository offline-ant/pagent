import assert from "node:assert/strict";
import test from "node:test";
import { agentConfiguration, effectiveTools, promptResource, TOOL_NAMES } from "../src/agent-config.ts";
import { nativeRequest } from "../src/native-request.ts";

test("agent descriptors validate settings and normalize only a leading relative dot", () => {
  assert.deepEqual(agentConfiguration({ model: "openai/gpt-5", systemPrompt: "./prompt.md", tools: ["console"], mode: "continuous", repeatPrompt: "do something", repeatDelayMs: 0 }),
    { model: "openai/gpt-5", systemPrompt: "prompt.md", tools: ["console"], mode: "continuous", repeatPrompt: "do something", repeatDelayMs: 0 });
  for (const value of ["", "/prompt.md", "../prompt.md", "./../prompt.md", "https://host/prompt.md", "data:text/plain,hi", "x/../prompt.md", "x/%2e%2e/prompt.md", "x\\prompt.md", "prompt.md?x", "./.private"]) assert.throws(() => promptResource(value), Error, value);
  for (const value of [{ model: "" }, { tools: ["bash"] }, { tools: ["console", "console"] }, { mode: "continious" }, { mode: "continuous" }, { repeatPrompt: " " }, { repeatDelayMs: -1 }, { repeatDelayMs: 1.5 }, { unknown: true }]) assert.throws(() => agentConfiguration(value));
});

test("host tool ceiling cannot be enlarged and local mode disables research", () => {
  assert.throws(() => effectiveTools({ tools: ["save"] }, ["console"], "open", "document"), /exceed/);
  assert.deepEqual(effectiveTools({}, [...TOOL_NAMES], "local", "none"), ["console", "reload", "wait"]);
  assert.deepEqual(effectiveTools({ tools: [] }, [...TOOL_NAMES], "open", "document"), []);
});

test("native ready/register carry pinned descriptors; control requests are explicit", () => {
  assert.deepEqual(nativeRequest({ type: "ready", after: 0, agents: [{ agentId: "one", systemPrompt: "./prompt.md" }] }),
    { type: "ready", after: 0, agents: [{ agentId: "one", systemPrompt: "prompt.md" }] });
  assert.deepEqual(nativeRequest({ type: "register", agentId: "one", tools: [] }), { type: "register", agentId: "one", tools: [] });
  assert.throws(() => nativeRequest({ type: "ready", after: 0, agents: ["one"] }), /descriptors/);
  assert.throws(() => nativeRequest({ type: "ready", after: 0, agents: [{ agentId: "one" }, { agentId: "one" }] }), /Duplicate/);
  for (const type of ["start", "nudge", "stop"]) assert.deepEqual(nativeRequest({ type }), { type });
});
