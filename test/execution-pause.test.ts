import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startPagent, type PagentApp } from "../src/app.ts";
import { openWorkspace } from "../src/storage.ts";

async function until(check: () => boolean | Promise<boolean>, timeout = 12_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await delay(25); }
  throw new Error("Deadline pause condition timed out.");
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} deadline pause retains living world and completed history across host-only intervals`, { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-deadline-pause-"));
    const logs: string[] = [];
    let app: PagentApp | undefined;
    try {
      const workspace = await openWorkspace({ directory, templateDir: fileURLToPath(new URL("../template/", import.meta.url)) });
      await workspace.write("/index.html", Buffer.from(`<!doctype html><script type="module" src="/agent.js"></script>
        <p-agent id="main" persist-end="body" repeat-prompt-raw="/fake-say retained answer"></p-agent>
        <p-agent id="slow" persist-end="body"></p-agent><p-agent id="waiter" persist-end="body"></p-agent>`));
      await workspace.close();
      const original = await readFile(path.join(directory, "index.html"), "utf8");
      app = await startPagent({ directory, browser, headless: true, fake: true, checkpoint: "private",
        tools: ["console", "wait"], durationMs: 8_000, deadlinePolicy: "pause",
        record: { intervalMs: 1_000, events: ["message", "tool"] }, log: message => logs.push(message),
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" });
      const live = app;
      const evaluate = (code: string) => live.browser.evaluateValue(code);
      let submissions = 0;
      for (const engine of app.agents.values()) {
        const submit = engine.submit.bind(engine);
        engine.submit = input => { submissions++; return submit(input); };
      }
      await evaluate(`(() => {
        window.liveHeap = { ticks: 0, events: 0, late: 0 };
        window.originalAgent = $('#main');
        const retained = window.liveHeap;
        addEventListener('pause-test', () => retained.events++);
        setInterval(() => retained.ticks++, 20);
      })()`);
      await assert.rejects(app.continue(), /pausing/);
      await app.start();
      await until(async () => await evaluate("$('#main').run?.status === 'complete'") === true);
      const firstMainRun = await evaluate("$('#main').run.id");
      const slowPrompt = "/fake-console new Promise(resolve => { window.finishDetached = () => { liveHeap.late++; resolve('late value'); }; })";
      const slowRun = await evaluate(`$('#slow').prompt(${JSON.stringify(slowPrompt)})`);
      await until(async () => await evaluate("typeof finishDetached === 'function'") === true);
      await evaluate(`$('#waiter').prompt(${JSON.stringify(`/fake-join ${String(slowRun)}`)})`);
      await until(async () => await evaluate("$('#waiter').run?.status === 'waiting'") === true);
      await until(() => app!.executionState === "paused");
      await app.flush();
      assert.equal(app.busy, false);
      assert.deepEqual(await evaluate("['slow','waiter'].map(id => $('#'+id).run.status)"), ["cancelled", "cancelled"]);
      assert.equal(await evaluate("$('#main') === originalAgent"), true);
      const pausedSubmissions = submissions;
      const ticks = Number(await evaluate("liveHeap.ticks"));
      await evaluate("dispatchEvent(new Event('pause-test')); finishDetached()");
      await delay(350);
      assert.equal(await evaluate("liveHeap.events"), 1);
      assert.equal(await evaluate("liveHeap.late"), 1, "detached JavaScript may complete without resuming inference");
      assert.ok(Number(await evaluate("liveHeap.ticks")) > ticks);
      assert.equal(submissions, pausedSubmissions);
      await assert.rejects(app.start(), /only the host operator/);
      assert.match(String(await evaluate("(() => { try { $('#main').prompt('not authorized'); } catch(e) { return e.message; } })()")), /paused/);
      for (const request of [{ type: "start" }, { type: "nudge" }, { type: "continue" }, { type: "submit", agentId: "main", id: "forged", runId: "forged-run" }]) {
        await evaluate(`aos.send(${JSON.stringify(request)})`);
      }
      await delay(100);
      await app.flush();
      assert.equal(app.executionState, "paused");
      assert.equal(submissions, pausedSubmissions, "native page requests cannot authorize another interval");
      const root = path.join(app.stateDirectory, "recordings");
      const firstArchive = (await readdir(root))[0];
      const firstManifest = await readFile(path.join(root, firstArchive, "manifest.jsonl"), "utf8");
      assert.equal(JSON.parse(firstManifest.trim().split("\n").at(-1)!).type, "stop");
      await delay(350);
      assert.equal(await readFile(path.join(root, firstArchive, "manifest.jsonl"), "utf8"), firstManifest);

      await app.continue();
      await until(async () => await evaluate("$('#main').run?.status === 'complete'") === true);
      assert.notEqual(await evaluate("$('#main').run.id"), firstMainRun);
      assert.equal(await evaluate("$('#main').messages.filter(m => m.role === 'assistant').length"), 2);
      // Both interrupted tool histories must be accepted by the real SDK in fresh turns.
      await evaluate("$('#slow').prompt('/fake-say continued slow'); $('#waiter').prompt('/fake-say continued waiter')");
      await until(async () => {
        const errors = await evaluate("['slow','waiter'].filter(id => $('#'+id).run.status === 'error').map(id => ({id, run: $('#'+id).run, messages: $('#'+id).messages}))");
        assert.deepEqual(errors, [], JSON.stringify(errors));
        return await evaluate("['slow','waiter'].every(id => $('#'+id).run.status === 'complete')") === true;
      });
      for (const id of ["slow", "waiter"]) {
        assert.equal(await evaluate(`$('#${id}').messages.some(message => message.role === 'toolResult')`), true, `${id} retained completed cancellation tool results`);
        assert.notEqual(await evaluate(`$('#${id}').run.id`), slowRun);
      }
      await evaluate("$('#slow').prompt('/fake-wait')");
      await until(() => app!.agents.get("slow")!.busy);
      await until(() => app!.executionState === "paused");
      assert.equal(await evaluate("$('#slow').run.status"), "cancelled", "provider-only inference is cancelled as well");
      await app.flush();
      await app.continue();
      await until(async () => await evaluate("$('#main').messages.filter(m => m.role === 'assistant').length === 3 && $('#main').run.status === 'complete'") === true);
      await until(() => app!.executionState === "paused");
      assert.equal(await evaluate("$('#main') === originalAgent && liveHeap.events === 1"), true);
      const archives = (await readdir(root)).sort();
      assert.equal(archives.length, 3);
      for (let index = 0; index < archives.length; index++) {
        const records = (await readFile(path.join(root, archives[index], "manifest.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as { type: string; previous?: string });
        assert.equal(records[0].previous, index ? archives[index - 1] : undefined);
        assert.equal(records.at(-1)?.type, "stop");
        assert.equal(records.some(record => record.type === "error"), false);
      }
      assert.equal(await readFile(path.join(root, firstArchive, "manifest.jsonl"), "utf8"), firstManifest);
      assert.equal(await readFile(path.join(directory, "index.html"), "utf8"), original);
      assert.doesNotMatch(logs.join("\n"), /runtime reset from|cleanup deadline|pause did not settle|delivery paused|checkpoint failed/i);
      await app.close();
      assert.equal(app.executionState, "stopped");
      await assert.rejects(app.continue(), /pausing/);
      await assert.rejects(access(path.join(app.stateDirectory, "host.lock")), { code: "ENOENT" });
      await assert.rejects(evaluate("true"), /closed|unavailable/);
    } finally {
      await app?.close();
      await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
