import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPagent, type PagentApp } from "../src/app.ts";
import type { HostEvent } from "../src/protocol.ts";

interface Frame {
  type: string;
  phase?: string;
  html?: string;
  events?: { kind: string; seq: number; agentId?: string; runId?: string; contentIndex?: number; callId?: string }[];
}

async function records(app: PagentApp): Promise<{ directory: string; frames: Frame[] }> {
  const root = path.join(app.stateDirectory, "recordings");
  const directory = path.join(root, (await readdir(root))[0]);
  return { directory, frames: (await readFile(path.join(directory, "manifest.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as Frame) };
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error("Recording integration condition timed out.");
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} faux completions capture only after page acknowledgment with SDK thinking boundaries`, { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-events-"));
    let app: PagentApp | undefined;
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
      app = await startPagent({ directory, browser, fake: true, headless: true, checkpoint: "none",
        tools: ["console"], record: { intervalMs: 30_000, events: ["tool", "thinking", "message"] },
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} });
      const session = app;
      await session.start();
      const acknowledged: HostEvent[] = [];
      const deliver = session.browser.deliver.bind(session.browser);
      let held = false;
      session.browser.deliver = async record => {
        if (!held && record.event.type === "message" && record.event.thinkingEnd !== undefined) {
          held = true;
          reached.resolve();
          await release.promise;
        }
        await deliver(record);
        acknowledged.push(record);
      };
      await session.browser.evaluateValue(`$('#main').prompt('/fake-think finished thought')`);
      await reached.promise;
      await delay(1_100);
      assert.deepEqual((await records(session)).frames.filter(frame => frame.type === "frame").map(frame => frame.phase), ["baseline"], "unacknowledged thought must not trigger capture");
      release.resolve();
      await until(() => !session.busy);
      await session.flush();
      await until(async () => (await records(session)).frames.some(frame => frame.events?.some(event => event.kind === "thinking")));
      await session.browser.evaluateValue(`$('#main').prompt('/fake-console document.body.dataset.completedTool = "yes"')`);
      await until(async () => await session.browser.evaluateValue(`$('#main').run.status === 'complete' && document.body.dataset.completedTool === 'yes'`) === true);
      await until(async () => (await records(session)).frames.some(frame => frame.events?.some(event => event.kind === "tool")));
      const archive = await records(session);
      const completions = archive.frames.filter(frame => frame.type === "frame").flatMap(frame => frame.events ?? []);
      assert.deepEqual(new Set(completions.map(event => event.kind)), new Set(["thinking", "message", "tool"]));
      assert.equal(completions.filter(event => event.kind === "thinking").length, 1, "one completed reasoning block, never a token/delta trigger");
      assert.equal(completions.find(event => event.kind === "thinking")?.contentIndex, 0);
      assert.equal(completions.filter(event => event.kind === "tool").length, 1);
      assert.equal(completions.filter(event => event.kind === "message").length, 3, "assistant messages only, not user or toolResult");
      for (const frame of archive.frames.filter(frame => frame.type === "frame" && frame.events?.length)) {
        const html = await readFile(path.join(archive.directory, frame.html!), "utf8");
        const cursor = Number(html.match(/data-pagent-seq="(\d+)"/)?.[1]);
        for (const event of frame.events!) {
          assert.equal(event.agentId, "main");
          assert.ok(event.runId);
          assert.ok(event.seq <= cursor, "captured DOM includes the acknowledged record");
          assert.ok(acknowledged.some(record => record.seq === event.seq));
        }
      }
      const toolFrame = archive.frames.find(frame => frame.events?.some(event => event.kind === "tool"))!;
      assert.match(await readFile(path.join(archive.directory, toolFrame.html!), "utf8"), /data-completed-tool="yes"/);
    } finally { release.resolve(); await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${browser} failed delivery and reconnect replay do not trigger recording`, { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-replay-"));
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, browser, fake: true, headless: true, checkpoint: "none", tools: [],
        record: { intervalMs: 30_000, events: ["thinking", "message"] },
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} });
      const session = app;
      await session.start();
      const deliver = session.browser.deliver.bind(session.browser);
      let failed = false;
      session.browser.deliver = async record => {
        if (!failed && record.event.type === "message" && record.event.thinkingEnd !== undefined) {
          failed = true;
          throw new Error("Deliberate failure before acknowledgment");
        }
        await deliver(record);
      };
      await session.browser.evaluateValue(`$('#main').prompt('/fake-think replayed once')`);
      await until(() => failed && !session.busy);
      await assert.rejects(session.flush(), /disconnected/);
      await session.browser.evaluateValue(`aos.send({type:'ready',after:Number(document.documentElement.dataset.pagentSeq),agents:pagent.agents.map(a=>a.configuration)})`);
      await until(async () => await session.browser.evaluateValue(`$('#main').canSubmit && $('#main').result === 'replayed once'`) === true);
      await session.flush();
      await delay(1_100);
      assert.deepEqual((await records(session)).frames.filter(frame => frame.type === "frame").map(frame => frame.phase), ["baseline"]);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}

test("reload cancels pending event captures before navigating the live runtime", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-reload-"));
  let app: PagentApp | undefined;
  try {
    app = await startPagent({ directory, browser: "chromium", fake: true, headless: true, checkpoint: "none", tools: [],
      record: { intervalMs: 30_000, events: ["message"] },
      noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} });
    const session = app;
    await session.start();
    await session.browser.evaluateValue(`$('#main').prompt('/fake-say completed before reload')`);
    await until(async () => await session.browser.evaluateValue(`$('#main').run.status === 'complete'`) === true);
    await session.flush();
    const nativeReload = session.browser.reload();
    // Reload stops a running execution; the app may close before reconnection.
    await nativeReload.catch(() => {});
    await session.close();
    await delay(1_100);
    const log = (await records(session)).frames;
    assert.equal(log.some(frame => frame.phase === "event"), false);
    assert.equal(log.at(-1)?.type, "stop");
  } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
});
