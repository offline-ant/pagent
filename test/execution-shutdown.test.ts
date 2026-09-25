import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPagent, type PagentApp } from "../src/app.ts";

interface FrameRecord { type: string; phase?: string; html?: string; actualMs: number }

async function until(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) { if (await check()) return; await delay(25); }
  throw new Error("Shutdown regression condition timed out.");
}

async function bounded<T>(operation: Promise<T>, timeoutMs = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function archive(app: PagentApp): Promise<{ directory: string; records: FrameRecord[]; text: string }> {
  const root = path.join(app.stateDirectory, "recordings");
  const names = await readdir(root);
  assert.equal(names.length, 1);
  const directory = path.join(root, names[0]);
  const text = await readFile(path.join(directory, "manifest.jsonl"), "utf8");
  return { directory, text, records: text.trim().split("\n").map(line => JSON.parse(line) as FrameRecord) };
}

for (const stop of ["deadline", "manual", "close"] as const) {
  test(`Firefox ${stop} captures the live world before cancelling console, never restoring original HTML`, { timeout: 35_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-terminal-firefox-"));
    const logs: string[] = [];
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, browser: "firefox", headless: true, fake: true,
        checkpoint: "private", tools: ["console"], durationMs: stop === "deadline" ? 2_500 : undefined,
        record: { intervalMs: 100, screenshots: true }, log: message => logs.push(message) });
      const original = await readFile(path.join(directory, "index.html"), "utf8");
      assert.equal(typeof app.browser.captureFrame, "function", "session wrapper forwards private capture");
      assert.match((await app.browser.captureFrame!({ screenshot: false })).html, /<p-agent/);
      await app.start();
      const prompt = '/fake-console (() => { document.body.dataset.terminalLive = "present"; return new Promise(() => {}); })()';
      await app.browser.evaluateValue(`$('#main').prompt(${JSON.stringify(prompt)})`);
      await until(async () => await app!.browser.evaluateValue('document.body.dataset.terminalLive === "present"') === true);
      await until(async () => {
        const saved = await archive(app!);
        const last = saved.records.findLast(record => record.type === "frame" && record.html);
        return Boolean(last && (await readFile(path.join(saved.directory, last.html!), "utf8")).includes('data-terminal-live="present"'));
      });
      if (stop === "manual") await bounded(app.stop());
      else if (stop === "close") await bounded(app.close());
      else await until(async () => app!.executionState === "stopped");
      await bounded(app.close());
      assert.equal(app.executionState, "stopped");
      await assert.rejects(access(path.join(app.stateDirectory, "host.lock")), { code: "ENOENT" });
      await assert.rejects(app.browser.evaluateValue("true"), /closed|unavailable/);
      assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), original);
      const saved = await archive(app);
      assert.equal(saved.records.at(-1)?.type, "stop");
      const final = saved.records.findLast(record => record.type === "frame" && record.phase === "final");
      assert.ok(final?.html, logs.join("\n"));
      assert.match(await readFile(path.join(saved.directory, final.html), "utf8"), /data-terminal-live="present"/);
      let liveObserved = false;
      for (const record of saved.records.filter(record => record.type === "frame" && record.html)) {
        const html = await readFile(path.join(saved.directory, record.html!), "utf8");
        const live = html.includes('data-terminal-live="present"');
        if (liveObserved) assert.equal(live, true, "recording must not switch to a restored world during shutdown");
        liveObserved ||= live;
      }
      assert.doesNotMatch(logs.join("\n"), /runtime reset from|cleanup deadline|reconnect failed/i);
      await delay(200);
      assert.equal((await archive(app)).text, saved.text, "terminal capture does not restart sampling");
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

for (const durationMs of [undefined, 3_600_000]) {
  test(`manual stop has an immediate cleanup bound with ${durationMs === undefined ? "no" : "a long"} duration and stalled cancellation`, { timeout: 25_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-stalled-stop-"));
    const logs: string[] = [];
    const released = Promise.withResolvers<void>();
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, browser: "chromium", headless: true, fake: true, durationMs,
        checkpoint: "none", tools: [], record: { intervalMs: 100 }, log: message => logs.push(message),
        noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1" });
      await app.start();
      const engine = app.agents.get("main")!;
      const cancel = engine.cancel.bind(engine);
      engine.cancel = async () => { await released.promise; await cancel(); };
      const started = performance.now();
      const stopping = app.stop();
      assert.equal(app.executionState, "stopped");
      await until(async () => (await archive(app!)).records.at(-1)?.type === "stop", 2_000);
      const stoppedArchive = await archive(app);
      assert.ok(performance.now() - started < 2_000, "recording stops without waiting for cancellation");
      await bounded(stopping, 8_000);
      await bounded(app.close(), 3_000);
      assert.ok(performance.now() - started < 9_000);
      await assert.rejects(app.browser.evaluateValue("true"), /closed|unavailable/);
      await assert.rejects(access(path.join(app.stateDirectory, "host.lock")), { code: "ENOENT" });
      assert.equal((await archive(app)).text, stoppedArchive.text);
      assert.equal(logs.filter(message => /cleanup deadline/i.test(message)).length, 1);
    } finally {
      released.resolve();
      await app?.close();
      await delay(50); // Retire the deliberately stalled test cancellation.
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}

for (const checkpoint of ["none", "private"] as const) {
  test(`${checkpoint} checkpoints start fresh on reload and a second host launch`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-fresh-launch-"));
    let app: PagentApp | undefined;
    const options = { directory, browser: "chromium" as const, headless: true, fake: true,
      checkpoint, tools: [], noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} };
    try {
      app = await startPagent(options);
      const original = await readFile(path.join(directory, "index.html"), "utf8");
      await app.browser.evaluateValue("$('#main').prompt('/fake-say first world')");
      await until(async () => await app!.browser.evaluateValue("$('#main').run?.status === 'complete'") === true);
      await app.flush();
      await app.browser.reload();
      assert.deepEqual(await app.browser.evaluateValue("$('#main').messages"), []);
      await app.browser.evaluateValue("$('#main').prompt('/fake-say second world')");
      await until(async () => await app!.browser.evaluateValue("$('#main').run?.status === 'complete'") === true);
      await app.close();
      assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), original);
      await assert.rejects(access(path.join(directory, ".pagent", "outbox.jsonl")), { code: "ENOENT" });
      app = await startPagent(options);
      assert.deepEqual(await app.browser.evaluateValue("$('#main').messages"), []);
      assert.equal(await app.browser.evaluateValue("$('#main').outputs.length"), 0);
      assert.equal(app.busy, false);
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
