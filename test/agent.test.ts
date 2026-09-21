import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFakeModel, prepareFakeResponse } from "../src/fake-model.ts";
import { createWebTools } from "pi-browser/web";
import { BrowserProcessLauncher, type BrowserOptions } from "pi-browser";
import { createEngine, validateHistory } from "../src/agent.ts";
import { buildSystemPrompt } from "../src/prompt.ts";
import type { AgentEvent, EngineOptions, PageBrowser } from "../src/protocol.ts";

function harness(cwd: string) {
  const events: AgentEvent[] = [];
  const operations: string[] = [];
  let memory = "initial page memory";
  const browser: PageBrowser = {
    async evaluate(code) {
      operations.push("console");
      assert.match(code, /fetch\('\/info.html'/);
      memory = "updated page memory";
      return { value: { written: "/info.html" }, logs: ["console smoke"] };
    },
    async evaluateValue() { return null; },
    async snapshot() { return "<!doctype html><body>saved</body>"; },
    async reload() { operations.push("reload"); },
    async deliver() {}, async screenshot() { return ""; }, async close() {},
  };
  const options: EngineOptions = {
    cwd, fake: true, browser,
    readContext: async () => ({ memory, outline: "<p-agent id=\"main\"></p-agent>", history: [] }),
    save: async () => { operations.push("save"); return "test-revision"; },
    emit: event => { events.push(event); },
  };
  return { options, events, operations };
}

function completedMessages(events: AgentEvent[]): unknown[] {
  return events.flatMap(event => event.type === "message" && event.phase === "end" ? [event.message] : []);
}

test("fake provider runs the real SDK loop, streams reasoning, and settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pagent-agent-"));
  const { options, events, operations } = harness(cwd);
  const engine = await createEngine(options);
  try {
    await engine.submit({ id: "prompt-0", prompt: "smoke", history: [] });
    assert.equal(engine.busy, false);
    assert.deepEqual(operations, ["console", "save", "reload"]);
    assert.ok(events.some(event => event.type === "message" && event.phase === "update" && JSON.stringify(event.message).includes("scripted smoke")));
    assert.deepEqual(events.flatMap(event => event.type === "tool" && event.phase === "end" ? [event.name] : []), ["console", "save", "reload"]);
    const messages = validateHistory(completedMessages(events));
    assert.equal(messages[0].role, "user");
    assert.equal(messages.at(-1)?.role, "assistant");
    assert.match(JSON.stringify(messages.at(-1)), /Pagent smoke complete/);
    assert.ok(!messages.some(message => JSON.stringify(message).includes("Live page context")));
  } finally {
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

for (const browserKind of ["chromium", "firefox"] as const) {
test(`${browserKind} context is exact and page-owned, with no AGENTS discovery or previous hidden conversation`, async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pagent-agent-"));
  await writeFile(join(cwd, "AGENTS.md"), "DO NOT LOAD THIS SENTINEL");
  await mkdir(join(cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(cwd, ".pi", "extensions", "evil.ts"), "throw new Error('Page-owned host code executed')");
  await writeFile(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: ["./extensions/evil.ts"] }));
  const { options, events } = harness(cwd);
  options.browserKind = browserKind;
  const engine = await createEngine(options);
  try {
    await engine.submit({ id: "old", prompt: "smoke", history: [] });
    events.length = 0;
    const prior = { role: "user", content: "edited page-owned history", timestamp: 1 };
    await engine.submit({ id: "next", prompt: "/fake-inspect", history: [prior] });
    const messages = validateHistory(completedMessages(events));
    const final = messages.at(-1);
    assert.equal(final?.role, "assistant");
    if (final?.role !== "assistant" || final.content[0]?.type !== "text") throw new Error("Missing inspection response");
    const context: unknown = JSON.parse(final.content[0].text);
    assert.ok(context && typeof context === "object" && "systemPrompt" in context && "messages" in context && "tools" in context);
    assert.equal(context.systemPrompt, buildSystemPrompt(browserKind), "Pi restores the prompt after the context hook appends live page context");
    assert.doesNotMatch(JSON.stringify(events.filter(event => event.type === "message")), /"role":"system"/, "host-owned system messages never reach page output or history");
    assert.match(JSON.stringify(context.messages), /edited page-owned history/);
    assert.match(JSON.stringify(context.messages), /updated page memory/);
    assert.doesNotMatch(JSON.stringify(context.messages), /Pagent smoke complete/);
    assert.doesNotMatch(JSON.stringify(context), /DO NOT LOAD THIS SENTINEL|Current working directory/);
    assert.ok(Array.isArray(context.tools));
    assert.deepEqual(context.tools.map(tool => tool.name), ["console", "save", "reload", "wait", "web_search", "web_fetch", "web_read"]);
    const web = createWebTools();
    try {
      for (const definition of web.tools) {
        const actual: { description: string; parameters: unknown } | undefined = context.tools.find((candidate: { name: string }) => candidate.name === definition.name);
        assert.ok(actual);
        assert.equal(actual.description, definition.description);
        assert.deepEqual(actual.parameters, definition.parameters);
      }
    } finally { await web.close(); }
  } finally {
    await engine.close();
    await rm(cwd, { recursive: true, force: true });
  }
});

}

test("history validation preserves metadata and rejects malformed roles, partials, and tool pairings", () => {
  const assistant = fauxAssistantMessage(fauxToolCall("console", { code: "1" }, { id: "call-1" }), { stopReason: "toolUse" });
  assistant.content.push({ type: "thinking", thinking: "visible reasoning", thinkingSignature: "opaque-provider-token" });
  const result = { role: "toolResult", toolCallId: "call-1", toolName: "console", content: [{ type: "text", text: "1" }], isError: false, timestamp: 2 };
  assert.deepEqual(validateHistory([assistant, result]), [assistant, result]);
  assert.throws(() => validateHistory([{ role: "system", content: "bypass", timestamp: 1 }]), /Invalid completed message/);
  const nested = { ...result, details: { list: [1, "two", null, { deep: true }] } };
  assert.deepEqual(validateHistory([assistant, nested]), [assistant, nested]);
  assert.throws(() => validateHistory([assistant, { ...result, details: { value: undefined } }]), /Invalid completed message/);
  assert.throws(() => validateHistory([{ ...assistant, content: [{ ...assistant.content[0], arguments: { code: () => 1 } }] }]), /Invalid completed message/);
  assert.throws(() => validateHistory([{ ...assistant, content: [{ ...assistant.content[0], arguments: ["not", "an", "object"] }] }]), /Invalid completed message/);
  assert.throws(() => validateHistory([{ ...assistant, stopReason: "pending" }]), /Invalid completed message/);
  assert.throws(() => validateHistory([assistant]), /unanswered tool calls/);
  assert.throws(() => validateHistory([result]), /Orphaned/);
  assert.throws(() => validateHistory([assistant, { ...result, toolName: "save" }]), /mismatched/);
  assert.throws(() => validateHistory([assistant, result, assistant, result]), /Duplicate/);
  assert.throws(() => validateHistory([{ ...assistant, usage: {} }]), /Invalid completed message/);
});

test("cancel during a pending fake request settles and rejects concurrent submissions", async () => {
  const { options } = harness(tmpdir());
  const engine = await createEngine(options);
  try {
    const run = engine.submit({ id: "wait", prompt: "/fake-wait", history: [] });
    assert.equal(engine.busy, true);
    await assert.rejects(engine.submit({ id: "other", prompt: "smoke", history: [] }), /busy/);
    await delay(50);
    await engine.cancel();
    assert.equal(await run, "cancelled");
    assert.equal(engine.busy, false);
    const early = engine.submit({ id: "early", prompt: "/fake-wait", history: [] });
    await engine.cancel();
    assert.equal(await early, "cancelled", "cancellation before SDK startup still has a cancelled outcome");
    await engine.submit({ id: "after", prompt: "/fake-inspect", history: [] });
  } finally { await engine.close(); }
});

for (const fake of [true, false]) {
  test(`${fake ? "fake" : "real"} runtime executes pi-browser web tools, emits results, and restores web history without network`, async t => {
    const cwd = await mkdtemp(join(tmpdir(), "pagent-agent-web-"));
    const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = cwd;
    t.after(async () => {
      if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
      await rm(cwd, { recursive: true, force: true });
    });
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
    t.mock.method(ModelRegistry.prototype, "getApiKeyForProvider", async (provider: string) => {
      assert.equal(provider, "openai-codex");
      return token;
    });
    const transport = t.mock.method(globalThis, "fetch", async (url: string | URL | Request) => {
      assert.equal(String(url), "https://chatgpt.com/backend-api/codex/alpha/search");
      return Response.json({ output: "Cite [reference](https://example.com/reference)." });
    });
    const { options, events } = harness(cwd);
    options.fake = fake;
    // Exercise real-runtime selection using a native faux provider, never a paid model.
    const provider = createFakeModel();
    if (!fake) {
      const credentials = new InMemoryCredentialStore();
      await credentials.modify("pagent-fake", async () => ({ type: "api_key", key: "test-only" }));
      const runtime = await ModelRuntime.create({
        credentials, modelsPath: null,
        modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
      });
      runtime.registerNativeProvider(provider.provider);
      await runtime.refresh({ allowNetwork: false });
      t.mock.method(ModelRuntime, "create", async () => runtime);
      options.model = "pagent-fake/local";
      prepareFakeResponse(provider, "/fake-web");
    }
    const engine = await createEngine(options);
    try {
      await engine.submit({ id: "web", prompt: "/fake-web", history: [] });
      assert.equal(transport.mock.callCount(), 2);
      assert.deepEqual(events.flatMap(event => event.type === "tool" ? [`${event.phase}:${event.name}`] : []), [
        "start:web_search", "end:web_search", "start:web_fetch", "end:web_fetch",
      ]);
      const history = validateHistory(completedMessages(events));
      const results = history.filter(message => message.role === "toolResult");
      assert.equal(results.length, 2);
      assert.ok(results.every(result => !result.isError));
      assert.match(JSON.stringify(results), /https:\/\/example.com\/reference/);
      assert.doesNotMatch(JSON.stringify(events), /test-account/);
      assert.ok(results.every(result => JSON.stringify(result.details).includes('"truncated":false')));
      events.length = 0;
      if (!fake) prepareFakeResponse(provider, "/fake-inspect");
      await engine.submit({ id: "restored", prompt: "/fake-inspect", history });
      const final = validateHistory(completedMessages(events)).at(-1);
      assert.ok(final?.role === "assistant" && final.content[0]?.type === "text");
      const context = JSON.parse(final.content[0].text);
      assert.deepEqual(context.tools.map((tool: { name: string }) => tool.name), ["console", "save", "reload", "wait", "web_search", "web_fetch", "web_read"]);
      assert.equal(context.messages.filter((message: { role: string }) => message.role === "toolResult").length, 2);
      assert.equal(transport.mock.callCount(), 2);
    } finally { await engine.close(); }
  });
}

test("explicit Codex authentication failures are tool errors and cancellation reaches transport", async t => {
  const backend = process.env.PI_WEB_BACKEND;
  process.env.PI_WEB_BACKEND = "codex";
  t.after(() => {
    if (backend === undefined) delete process.env.PI_WEB_BACKEND;
    else process.env.PI_WEB_BACKEND = backend;
  });
  const cwd = await mkdtemp(join(tmpdir(), "pagent-agent-web-cancel-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = cwd;
  t.after(async () => {
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(cwd, { recursive: true, force: true });
  });
  const { options, events } = harness(cwd);
  const auth = t.mock.method(ModelRegistry.prototype, "getApiKeyForProvider", async (): Promise<string | undefined> => undefined);
  const transport = t.mock.method(globalThis, "fetch", async (): Promise<Response> => { throw new Error("Unexpected network request"); });
  const engine = await createEngine(options);
  try {
    await engine.submit({ id: "auth", prompt: "/fake-web", history: [] });
    assert.equal(transport.mock.callCount(), 0);
    const failures = events.filter(event => event.type === "tool" && event.phase === "end");
    assert.equal(failures.length, 2);
    assert.ok(failures.every(event => event.type === "tool" && event.isError));
    assert.match(JSON.stringify(failures), /No OpenAI Codex OAuth token found/);
    const token = `test.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "test-account" } })).toString("base64url")}.test`;
    auth.mock.mockImplementation(async () => token);
    let started!: (signal: AbortSignal) => void;
    const ready = new Promise<AbortSignal>(resolve => { started = resolve; });
    transport.mock.mockImplementation(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal);
      started(init.signal);
      init.signal.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    }));
    const run = engine.submit({ id: "cancel", prompt: "/fake-web", history: [] });
    const signal = await ready;
    await engine.cancel();
    await run;
    assert.equal(signal.aborted, true);
    assert.equal(engine.busy, false);
  } finally { await engine.close(); }
});

test("research honors environment settings unless a host explicitly overrides headless mode", async t => {
  const environment = { PI_WEB_BACKEND: process.env.PI_WEB_BACKEND, PI_WEB_BROWSER: process.env.PI_WEB_BROWSER,
    PI_BROWSER_HEADLESS: process.env.PI_BROWSER_HEADLESS };
  process.env.PI_WEB_BACKEND = "browser";
  process.env.PI_BROWSER_HEADLESS = "true";
  t.after(() => {
    for (const [key, value] of Object.entries(environment)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const launches: BrowserOptions[] = [];
  t.mock.method(BrowserProcessLauncher, "create", async (options: BrowserOptions) => {
    launches.push(options);
    throw new Error("Test stopped before browser launch");
  });
  for (const explicit of [false, true]) {
    if (explicit) process.env.PI_WEB_BROWSER = "chromium";
    else delete process.env.PI_WEB_BROWSER;
    const { options } = harness(tmpdir());
    options.browserKind = "firefox";
    if (explicit) options.webHeadless = false;
    const engine = await createEngine(options);
    try { await engine.submit({ id: `settings-${explicit}`, prompt: "/fake-fetch http://127.0.0.1/fixture", history: [] }); }
    finally { await engine.close(); }
  }
  assert.deepEqual(launches.map(options => ({ browser: options.browser, headless: options.headless })), [
    { browser: "firefox", headless: true }, // Workspace engine default, environment headless.
    { browser: "chromium", headless: false }, // Explicit environment engine and host headless.
  ]);
});

test("broken page context aborts rather than silently generating without memory", async () => {
  const { options } = harness(tmpdir());
  options.readContext = async () => { throw new Error("context is broken"); };
  const engine = await createEngine(options);
  try {
    await assert.rejects(engine.submit({ id: "broken", prompt: "/fake-inspect", history: [] }), /context is broken/);
    assert.equal(engine.busy, false);
  } finally { await engine.close(); }
});
