import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import type { WebAttention } from "pi-browser/web";
import type { AgentEvent } from "../src/protocol.ts";
import { WebAttentionCoordinator } from "../src/web-tools.ts";

const request: WebAttention = {
  id: "web-attention-1", reason: "Complete the challenge", url: "https://example.com/challenge", tabId: "research-1",
};

function coordinator() {
  const events: AgentEvent[] = [];
  return { events, attention: new WebAttentionCoordinator(event => events.push(event)) };
}

test("web integration imports pi-browser factories without discovering extensions or sibling source", async () => {
  const source = await readFile(new URL("../src/agent.ts", import.meta.url), "utf8");
  assert.match(source, /import \{ createWebTools, SnapshotStore \} from "pi-browser\/web"/);
  assert.match(source, /\.\.\.web\.tools/);
  assert.doesNotMatch(source, /pi-ant|loadWebTools|DefaultResourceLoader|additionalExtensionPaths/);
  const agents = await readFile(new URL("../src/session-agents.ts", import.meta.url), "utf8");
  assert.match(agents, /webProfileDir: join\(this\.options\.stateDirectory, "research", createHash\("sha256"\)\.update\(id\)\.digest\("hex"\)\)/);
  assert.match(agents, /webSnapshotDirectory: join\(this\.options\.stateDirectory, "web-snapshots", createHash\("sha256"\)\.update\(id\)\.digest\("hex"\)\)/);
  assert.match(source, /snapshots: new SnapshotStore\(\{ directory: options.webSnapshotDirectory \}\)/);
  assert.match(source, /finally \{ await web\.close\(\); \}/);
});

test("Continue resolves the active intervention and clears it without browser navigation", async () => {
  const { attention, events } = coordinator();
  const result = attention.wait(request);
  assert.deepEqual(attention.current, request);
  const observed = attention.current!;
  observed.id = "page-owned-mutation";
  assert.equal(attention.current!.id, request.id);
  assert.deepEqual(events, [{ type: "web-attention", request }]);
  attention.respond(request.id, true);
  assert.equal(await result, true);
  assert.equal(attention.current, null);
  assert.deepEqual(events.at(-1), { type: "web-attention", request: null });
  assert.throws(() => attention.respond(request.id, true), /no longer active/);
});

test("Cancel, stale IDs, and concurrent intervention attempts preserve host ownership", async () => {
  const { attention } = coordinator();
  const first = attention.wait(request);
  assert.throws(() => attention.respond("stale-id", true), /no longer active/);
  assert.deepEqual(attention.current, request);
  assert.throws(() => attention.wait({ ...request, id: "second" }), /already waiting/);
  attention.respond(request.id, false);
  assert.equal(await first, false);
  const second = attention.wait({ ...request, id: "second" });
  assert.throws(() => attention.respond(request.id, true), /no longer active/);
  attention.cancel();
  assert.equal(await second, false);
  assert.equal(attention.current, null);
  attention.cancel();
});

test("abort interrupts attention immediately and never revives a cancelled request", async () => {
  const { attention, events } = coordinator();
  const controller = new AbortController();
  const result = attention.wait(request, controller.signal);
  const rejected = assert.rejects(result, /cancelled by test/);
  controller.abort(new Error("cancelled by test"));
  await rejected;
  assert.equal(attention.current, null);
  assert.deepEqual(events.at(-1), { type: "web-attention", request: null });
  assert.throws(() => attention.respond(request.id, true), /no longer active/);
  const count = events.length;
  assert.throws(() => attention.wait(request, controller.signal), /cancelled by test/);
  assert.equal(events.length, count);
});

test("settled intervention removes its abort listener before another request begins", async () => {
  const { attention, events } = coordinator();
  const controller = new AbortController();
  const first = attention.wait(request, controller.signal);
  attention.respond(request.id, true);
  await first;
  const second = attention.wait({ ...request, id: "second" });
  const count = events.length;
  controller.abort(new Error("late abort"));
  assert.equal(events.length, count);
  assert.equal(attention.current!.id, "second");
  attention.cancel();
  assert.equal(await second, false);
});
