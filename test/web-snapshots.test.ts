import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore, type JsonObject } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { SnapshotStore } from "pi-browser/web";
import { createEngineFactory, validateHistory } from "../src/agent.ts";
import { createFakeModel } from "../src/fake-model.ts";
import { SessionAgents } from "../src/session-agents.ts";
import type { AgentEvent, PageBrowser } from "../src/protocol.ts";

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
const scope = (state: string, id: string) => join(state, "web-snapshots", createHash("sha256").update(id).digest("hex"));
const browser: PageBrowser = {
  async evaluate() { throw new Error("No evaluation in snapshot reads"); },
  async evaluateValue() { return null; }, async snapshot() { return "<!doctype html><title>saved</title>"; },
  async reload() {}, async deliver() {}, async screenshot() { throw new Error("No live screenshots"); }, async close() {},
};

test("model web_read is agent-scoped, network-free, and survives disposal and host recreation with cursors/images", async t => {
  const root = await mkdtemp(join(tmpdir(), "pagent-snapshot-engine-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = createFakeModel();
  const credentials = new InMemoryCredentialStore();
  await credentials.modify("pagent-fake", async () => ({ type: "api_key", key: "test-only" }));
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(provider.provider);
  await runtime.refresh({ allowNetwork: false });
  t.mock.method(ModelRuntime, "create", async () => runtime);
  t.mock.method(globalThis, "fetch", async () => { throw new Error("Snapshot read performed network I/O"); });
  const factory = await createEngineFactory({ model: "pagent-fake/local" });
  const events: AgentEvent[] = [];
  const makePool = () => SessionAgents.create({ factory, directory: root, stateDirectory: root,
    browserKind: "chromium", browser, diagnostics: () => ({}),
    readContext: async () => ({ memory: "", outline: "", history: [], prompt: "Read saved evidence" }),
    save: async () => "saved", emit: event => events.push(event), changed() {}, blocked: () => false, log() {},
  });
  let pool = await makePool();
  const store = new SnapshotStore({ directory: scope(root, "a") });
  const saved = await store.save({ kind: "fetch", metadata: { url: "https://example.com/evidence" },
    md: "captured line\n".repeat(4000), screenshot: png });
  const first = await store.read(saved.id);
  assert.ok(first.nextCursor);
  async function read(id: string, args: JsonObject) {
    events.length = 0;
    provider.setResponses([
      fauxAssistantMessage(fauxToolCall("web_read", args), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        assert.ok(result, "tool result reaches the next model request");
        return fauxAssistantMessage("Read complete");
      },
    ]);
    await pool.submit(id, "input", crypto.randomUUID());
    const history = validateHistory(events.flatMap(event => event.type === "message" && event.phase === "end" ? [event.message] : []));
    const result = history.find(message => message.role === "toolResult");
    assert.ok(result?.role === "toolResult");
    assert.doesNotMatch(JSON.stringify(result), new RegExp(root));
    return result;
  }
  try {
    assert.equal((await read("a", { snapshot: saved.id })).isError, false);
    const sibling = await read("b", { snapshot: saved.id });
    assert.equal(sibling.isError, true);
    assert.match(JSON.stringify(sibling), /expired|not present/);
    await pool.dispose("a");
    assert.equal((await read("a", { snapshot: saved.id, cursor: first.nextCursor })).isError, false);
    await pool.close();
    pool = await makePool();
    const continued = await read("a", { snapshot: saved.id, cursor: first.nextCursor });
    assert.equal(continued.isError, false);
    const image = await read("a", { snapshot: saved.id, format: "screenshot" });
    assert.deepEqual(image.content.find(block => block.type === "image"), { type: "image", data: png, mimeType: "image/png" });
    assert.ok(Buffer.byteLength(JSON.stringify(image)) < 2048, "small screenshots remain small native history blocks");
    const oversized = { ...image, content: [{ type: "image", mimeType: "image/png", data: "a".repeat(8 * 1024 * 1024) }] };
    assert.throws(() => validateHistory([oversized]), /History exceeds 8 MiB/);
  } finally { await pool.close(); }
});
