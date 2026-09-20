import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WebBackend } from "pi-browser/web";
import { createEngine } from "../src/agent.ts";
import type { AgentEvent, AgentEngine, EngineOptions, PageBrowser } from "../src/protocol.ts";
import { readWebBackendOverride, writeWebBackendOverride } from "../src/web-backend.ts";

const unusedBrowser: PageBrowser = {
  async evaluate() { throw new Error("Unexpected browser operation"); },
  async evaluateValue() { throw new Error("Unexpected context collection"); },
  async snapshot() { throw new Error("Unexpected checkpoint"); },
  async reload() { throw new Error("Unexpected reload"); },
  async deliver() { throw new Error("Unexpected delivery"); },
  async screenshot() { throw new Error("Unexpected screenshot"); },
  async close() {},
};

test("web backend override is atomically stored as private state and reset remains distinct from Auto", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-web-backend-"));
  try {
    assert.equal(await readWebBackendOverride(directory), null);
    for (const override of ["auto", "codex", "browser", null] as const) {
      await writeWebBackendOverride(directory, override);
      assert.equal(await readWebBackendOverride(directory), override);
      assert.equal(JSON.parse(await readFile(join(directory, "web-backend.json"), "utf8")), override);
      assert.equal((await stat(join(directory, "web-backend.json"))).mode & 0o777, 0o600);
      assert.deepEqual(await readdir(directory), ["web-backend.json"], "atomic writes leave no temporary files");
    }
    assert.throws(() => writeWebBackendOverride(directory, "invalid" as WebBackend), /Invalid web backend/);
    assert.equal(await readWebBackendOverride(directory), null, "invalid update leaves the stored override unchanged");
    await writeFile(join(directory, "web-backend.json"), '"invalid"');
    await assert.rejects(readWebBackendOverride(directory), /Invalid private web backend/);
    await writeFile(join(directory, "web-backend.json"), "{");
    await assert.rejects(readWebBackendOverride(directory), SyntaxError);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("engine restores workspace overrides, serializes updates, and resets to original configuration without inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-web-backend-engine-"));
  const events: AgentEvent[] = [];
  const options: EngineOptions = {
    cwd: directory, webStateDirectory: directory, fake: true, browser: unusedBrowser,
    readContext: async () => { throw new Error("Backend controls must not collect model context"); },
    save: async () => { throw new Error("Backend controls must not checkpoint history"); },
    emit: event => events.push(event),
  };
  let engine: AgentEngine | undefined;
  try {
    engine = await createEngine(options);
    const configured = engine.getBackendState();
    assert.equal(configured.override, null);
    await Promise.all([engine.setBackendOverride("browser"), engine.setBackendOverride("codex"), engine.setBackendOverride("auto")]);
    assert.deepEqual(engine.getBackendState(), { ...configured, override: "auto", effective: "auto", source: "override" });
    assert.equal(await readWebBackendOverride(directory), "auto");
    assert.deepEqual(events.map(event => event.type === "backend-state" ? event.state.override : event.type), ["browser", "codex", "auto"]);
    await engine.close();
    engine = await createEngine({ ...options, browserKind: "firefox" });
    assert.equal(engine.getBackendState().override, "auto", "browser engine changes do not reset workspace preferences");
    await engine.setBackendOverride(null);
    assert.deepEqual(engine.getBackendState(), configured, "reset restores the original default and its source");
    await engine.close();
    engine = await createEngine(options);
    assert.deepEqual(engine.getBackendState(), configured, "reset persists across engine restarts");
    assert.equal(engine.busy, false);
    assert(events.every(event => event.type === "backend-state"), "no model calls, history events, or browser operations");
  } finally {
    await engine?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
