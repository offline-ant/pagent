import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createEngine, createEngineFactory, validateHistory } from "../src/agent.ts";
import { createFakeModel, prepareFakeResponse } from "../src/fake-model.ts";
import type { AgentEvent, AgentRun, EngineOptions, PageBrowser } from "../src/protocol.ts";

function harness(agentId: string) {
  const events: AgentEvent[] = [];
  const browser: PageBrowser = {
    async evaluate() { return { value: "console result", logs: [] }; },
    async evaluateValue() { return null; },
    async snapshot() { return "<!doctype html>"; },
    async reload() {}, async deliver() {}, async screenshot() { return ""; }, async close() {},
  };
  const options: EngineOptions = {
    cwd: tmpdir(), fake: true, agentId, browser,
    readContext: async () => ({ memory: `${agentId} memory`, outline: `<p-agent id="${agentId}"></p-agent>`, history: [] }),
    save: async () => "revision", emit: event => events.push(event),
  };
  return { options, events };
}

function answer(events: AgentEvent[]): string {
  const messages = validateHistory(events.flatMap(event => event.type === "message" && event.phase === "end" ? [event.message] : []));
  const last = messages.at(-1);
  assert.ok(last?.role === "assistant");
  return last.content.flatMap(block => block.type === "text" ? [block.text] : []).join("\n");
}

function toolResult(events: AgentEvent[]) {
  const event = events.findLast(event => event.type === "tool" && event.phase === "end");
  assert.ok(event?.type === "tool");
  return event;
}

const result: AgentRun = { id: "run-child", agentId: "child", inputId: "input-child", status: "complete", result: "Child answer" };

test("factory faux engines have independent response queues and cancellation", async () => {
  const factory = await createEngineFactory({ fake: true });
  const first = harness("first");
  const second = harness("second");
  const [a, b] = await Promise.all([factory.create(first.options), factory.create(second.options)]);
  try {
    assert.equal(factory.modelLabel, a.modelLabel);
    assert.equal(a.modelLabel, b.modelLabel);
    let release!: () => void;
    let started!: () => void;
    const ready = new Promise<void>(resolve => { started = resolve; });
    first.options.browser.evaluate = async () => {
      started();
      await new Promise<void>(resolve => { release = resolve; });
      return { value: "first engine only", logs: [] };
    };
    const pending = a.submit({ id: "first-input", prompt: "/fake-console 1", history: [] });
    await ready;
    await b.submit({ id: "second-input", prompt: "/fake-say second engine only", history: [] });
    assert.equal(answer(second.events), "second engine only");
    assert.equal(a.busy, true);
    release();
    await pending;
    assert.match(answer(first.events), /first engine only/);
    assert.doesNotMatch(answer(first.events), /second engine only/);
    first.events.length = 0;
    const waiting = a.submit({ id: "waiting", prompt: "/fake-wait", history: [] });
    await delay(20);
    await a.cancel();
    await waiting;
    second.events.length = 0;
    await b.submit({ id: "after", prompt: "/fake-say still usable", history: [] });
    assert.equal(answer(second.events), "still usable");
  } finally { await Promise.all([a.close(), b.close()]); }
});

test("real factory resolves model/runtime once and closing one engine leaves siblings usable", async t => {
  const provider = createFakeModel();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("pagent-fake", async () => ({ type: "api_key", key: "test-only" }));
  const runtime = await ModelRuntime.create({
    credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  runtime.registerNativeProvider(provider.provider);
  await runtime.refresh({ allowNetwork: false });
  const creation = t.mock.method(ModelRuntime, "create", async () => runtime);
  const factory = await createEngineFactory({ model: "pagent-fake/local", thinking: "high" });
  const first = harness("first");
  const second = harness("second");
  const [a, b] = await Promise.all([factory.create(first.options), factory.create(second.options)]);
  try {
    assert.equal(creation.mock.callCount(), 1);
    await a.close();
    prepareFakeResponse(provider, "/fake-say sibling survived");
    await b.submit({ id: "second", prompt: "/fake-say sibling survived", history: [] });
    assert.equal(answer(second.events), "sibling survived");
    assert.equal(creation.mock.callCount(), 1);
  } finally { await b.close(); }
});

test("wait joins host run IDs without evaluating browser code", async () => {
  const { options, events } = harness("parent");
  options.browser.evaluate = async () => { throw new Error("wait occupied the browser queue"); };
  options.waitForRuns = async (runs, signal) => {
    assert.deepEqual(runs, ["run-child"]);
    assert.ok(signal);
    return [result];
  };
  const engine = await createEngine(options);
  try {
    await engine.submit({ id: "join", prompt: "/fake-join run-child", history: [] });
    assert.equal(toolResult(events).isError, false);
    assert.match(answer(events), /Child answer/);
    assert.match(answer(events), /run-child/);
  } finally { await engine.close(); }
});

test("wait validates unique bounded run IDs and reports missing host support", async () => {
  const { options, events } = harness("parent");
  let calls = 0;
  options.waitForRuns = async () => { calls++; return [result]; };
  const engine = await createEngine(options);
  try {
    for (const input of ["run-child,run-child", "", "x".repeat(201), Array.from({ length: 9 }, (_, index) => `run-${index}`).join(",")]) {
      events.length = 0;
      await engine.submit({ id: "invalid", prompt: `/fake-join ${input}`, history: [] });
      assert.equal(toolResult(events).isError, true, input);
    }
    assert.equal(calls, 0);
    options.waitForRuns = undefined;
    events.length = 0;
    await engine.submit({ id: "unsupported", prompt: "/fake-join run-child", history: [] });
    assert.equal(toolResult(events).isError, true);
    assert.match(JSON.stringify(toolResult(events)), /host does not provide agent joining/);
  } finally { await engine.close(); }
});

test("wait forwards cancellation to the host and bounds returned answers", async () => {
  const { options, events } = harness("parent");
  let started!: (signal: AbortSignal) => void;
  const ready = new Promise<AbortSignal>(resolve => { started = resolve; });
  options.waitForRuns = async (_runs, signal) => {
    assert.ok(signal);
    started(signal);
    await delay(60_000, undefined, { signal });
    return [result];
  };
  const engine = await createEngine(options);
  try {
    const pending = engine.submit({ id: "cancel", prompt: "/fake-join run-child", history: [] });
    const signal = await ready;
    await engine.cancel();
    await pending;
    assert.equal(signal.aborted, true);
    assert.equal(engine.busy, false);
    options.waitForRuns = async () => [{ ...result, result: "x".repeat(100_000) }];
    events.length = 0;
    await engine.submit({ id: "large", prompt: "/fake-join run-child", history: [] });
    const completed = toolResult(events);
    assert.equal(completed.isError, false);
    assert.match(JSON.stringify(completed.result), /Truncated to 50 KiB/);
    assert.ok(Buffer.byteLength(JSON.stringify(completed.result)) < 52 * 1024);
  } finally { await engine.close(); }
});

test("identity and fresh diagnostics accompany every model request without separate transcript records", async () => {
  const { options, events } = harness("research");
  let contextReads = 0;
  let diagnosticReads = 0;
  let diagnostic = "idle timer warning";
  options.readContext = async () => {
    contextReads++;
    return { memory: "current memory", outline: "<p-agent id=research></p-agent>", history: [] };
  };
  options.diagnostics = () => { diagnosticReads++; return { entries: [{ seq: diagnosticReads, level: "warn", text: diagnostic }] }; };
  options.browser.evaluate = async () => {
    diagnostic = "error after tool";
    return { value: 1, logs: [] };
  };
  const engine = await createEngine(options);
  try {
    await engine.submit({ id: "inspect", prompt: "/fake-inspect", history: [] });
    assert.match(answer(events), /idle timer warning/);
    assert.match(answer(events), /agentId.*research/);
    assert.match(answer(events), /untrusted observed data/);
    assert.equal(contextReads, 1);
    assert.equal(diagnosticReads, 1);
    events.length = 0;
    await engine.submit({ id: "console", prompt: "/fake-console 1", history: [] });
    assert.equal(contextReads, 3, "context is refreshed before the request after console as well");
    assert.equal(diagnosticReads, contextReads);
    assert.doesNotMatch(JSON.stringify(events), /idle timer warning|error after tool|pagent-live-context/);
    events.length = 0;
    await engine.submit({ id: "inspect-again", prompt: "/fake-inspect", history: [] });
    assert.match(answer(events), /error after tool/);
    assert.doesNotMatch(answer(events), /idle timer warning/);
    assert.equal(diagnosticReads, contextReads);
  } finally { await engine.close(); }
});
