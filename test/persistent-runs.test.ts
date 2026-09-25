import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import { startServer } from "../src/server.ts";
import { startSession, type PagentSession, type SessionOptions } from "../src/session.ts";
import { openWorkspace } from "../src/storage.ts";
import type { PageBrowser, BrowserKind } from "../src/protocol.ts";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error("Persistent run condition timed out.");
}

const ids = ["a1", "a2", "b1", "b2", "c1", "c2"];
async function fixture(browserKind: BrowserKind, settings: Partial<SessionOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pagent-persistent-runs-"));
  const workspace = await openWorkspace({ directory, templateDir: fileURLToPath(new URL("../template/", import.meta.url)) });
  await workspace.write("/index.html", Buffer.from(`<!doctype html><html><head><script type="module" src="/agent.js"></script></head><body>${ids.map(id => `<p-agent id="${id}" persist-end="body"></p-agent>`).join("")}</body></html>`));
  const server = await startServer(workspace);
  let browser: PageBrowser | undefined;
  let session: PagentSession | undefined;
  const requests: Array<Record<string, unknown>> = [];
  const logs: string[] = [];
  async function close() {
    await session?.close(); await browser?.close(); await server.close(); await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    session = await startSession({ workspace, url: server.url, browserKind, fake: true, checkpoint: "none", tools: ["console"],
      log: message => logs.push(message), onClose: () => {}, ...settings,
      createBrowser: async options => {
        browser = await launchBrowser({ ...options, onRequest: request => { requests.push(request as Record<string, unknown>); options.onRequest(request); },
          browser: browserKind, headless: true, profileDir: join(workspace.stateDirectory, browserKind),
          noSandbox: browserKind === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" });
        return browser;
      },
    });
    return { session, requests, logs, close };
  } catch (error) { await close(); throw error; }
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser}: six concurrent faux runs survive their own whole-body replacements without identity churn`, { timeout: 70_000 }, async () => {
    const f = await fixture(browser);
    const value = (expression: string) => f.session.browser.evaluateValue(expression);
    const engines = [...f.session.agents.values()];
    try {
      await value(`window.originals = pagent.agents;
        window.roots = originals.map(a => a.shadowRoot);
        window.drafts = originals.map(a => a.inputs[0]);
        drafts.forEach((input, i) => input.value = 'human draft ' + i);
        originals.forEach(a => a.prompt('/fake-say prior answer ' + a.id));`);
      await until(async () => await value("originals.every(a => a.run?.status === 'complete')") === true);
      await f.session.flush();
      const before = f.requests.length;
      await value(`window.histories = originals.map(a => JSON.stringify(a.messages));
        window.replacements = []; window.activeCounts = [];
        window.runs = originals.map((a, i) => a.prompt('/fake-console ' +
          '(async () => { activeCounts.push(originals.filter(a => a.state.busy).length); ' +
          (i === 0 ? 'document.body.innerHTML = document.body.innerHTML;' :
           i === 1 ? 'const body = document.createElement("body"); body.innerHTML = "<article>replacement body</article>"; document.body.replaceWith(body);' :
           'document.body.innerHTML = "<article>new artwork</article>";') +
          'await new Promise(resolve => setTimeout(resolve, 50)); replacements.push(' + i + '); return originals.every(a => a.isConnected); })()'));
      `);
      await until(async () => await value("originals.every(a => ['complete','error','cancelled'].includes(a.run?.status))") === true);
      await f.session.flush();
      assert.equal(await value("originals.every(a => a.run.status === 'complete')"), true, f.logs.join("\n"));
      assert.equal(await value("activeCounts[0]"), 6, "six runs were active at the first destructive console call");
      assert.equal(await value("replacements.length"), 6);
      assert.equal(await value(`originals.every((a, i) => document.getElementById(a.id) === a && a.shadowRoot === roots[i] &&
        a.run.id === runs[i] && a.inputs.at(-1) === drafts[i] && drafts[i].value === 'human draft ' + i &&
        JSON.stringify(a.messages.slice(0,2)) === histories[i])`), true);
      assert.deepEqual(await value("pagent.agents.map(a => a.id)"), ids);
      assert.deepEqual([...f.session.agents.values()], engines, "host engines were not replaced");
      assert.equal(f.requests.slice(before).filter(request => request.type === "submit").length, 6);
      assert.deepEqual(f.requests.slice(before).filter(request => ["dispose", "register", "ready"].includes(String(request.type))), []);
      assert.doesNotMatch(f.logs.join("\n"), /disconnected|paused|reconnect failed/i);
      assert.equal(await value("originals.every(a => !JSON.parse(a.result).isError)"), true);
    } finally { await f.close(); }
  });

  test(`${browser}: explicit disposal cancels an active persistent identity and releases it without disturbing siblings`, { timeout: 50_000 }, async () => {
    const f = await fixture(browser);
    const value = (expression: string) => f.session.browser.evaluateValue(expression);
    const engines = new Map(f.session.agents);
    try {
      await value(`window.originals = pagent.agents;
        window.disposalEvents = [];
        aos.addEventListener('event', event => {
          if (event.detail.agentId === 'a1') disposalEvents.push(event.detail.event.type);
        });
        window.runs = originals.map(agent => agent.prompt('/fake-wait'));`);
      await until(() => [...f.session.agents.values()].every(engine => engine.busy));
      await until(async () => await value("originals.every(agent => agent.run?.status === 'running')") === true);
      const before = f.requests.length;
      await value("originals[0].dispose()");
      await until(() => !f.session.agents.has("a1"));
      await until(async () => await value("originals[0].identity === undefined && !originals[0].closing") === true);
      await f.session.flush();
      assert.equal(engines.get("a1")!.busy, false, "disposed engine settled cancellation");
      assert.equal(await value("!originals[0].isConnected && originals[0].run.id === runs[0] && originals[0].run.status === 'cancelled'"), true);
      assert.equal(await value("disposalEvents.filter(type => type === 'disposed').length"), 1, "real host acknowledged identity release once");
      assert.deepEqual(f.requests.slice(before), [{ type: "dispose", agentId: "a1" }]);
      for (const id of ids.slice(1)) {
        assert.equal(f.session.agents.get(id), engines.get(id));
        assert.equal(f.session.agents.get(id)!.busy, true, `${id} remains active`);
      }

      // Another recovery batch must not bring back the deliberately retired agent.
      await value("document.body.innerHTML = '<article>after disposal</article>'");
      await until(async () => await value("originals.slice(1).every(agent => agent.isConnected)") === true);
      assert.equal(await value("document.getElementById('a1') === null && !originals[0].isConnected"), true);
      assert.equal(await value("originals.slice(1).every((agent, i) => agent.run.id === runs[i + 1] && agent.run.status === 'running')"), true);
      assert.deepEqual(f.requests.slice(before), [{ type: "dispose", agentId: "a1" }], "neither retirement nor recovery restarts inference");

      // A new element can claim the acknowledged ID, but attachment is not kickoff.
      await value(`window.replacement = document.createElement('p-agent');
        replacement.id = 'a1'; replacement.setAttribute('persist-end', 'body'); document.body.append(replacement);`);
      await until(async () => await value("replacement.connected") === true);
      assert.notEqual(f.session.agents.get("a1"), engines.get("a1"));
      assert.equal(await value("replacement !== originals[0] && !replacement.run && replacement.messages.length === 0"), true);
      assert.equal(f.session.agents.get("a1")!.busy, false);
      assert.deepEqual(f.requests.slice(before), [{ type: "dispose", agentId: "a1" }, { type: "register", agentId: "a1" }]);
      assert.doesNotMatch(f.logs.join("\n"), /disconnected|paused|reconnect failed/i);
    } finally { await f.close(); }
  });

  for (const terminal of ["stop", "deadline", "close"] as const) {
    test(`${browser}: host ${terminal} suppresses recovery and never submits a replacement run`, { timeout: 45_000 }, async () => {
      const f = await fixture(browser, { durationMs: terminal === "deadline" ? 1_000 : undefined });
      const value = (expression: string) => f.session.browser.evaluateValue(expression);
      try {
        await f.session.start();
        await value("window.originals = pagent.agents; originals.forEach(a => a.prompt('/fake-wait'))");
        await until(() => f.session.busy);
        if (terminal === "close") await f.session.close();
        else if (terminal === "stop") await f.session.stop();
        else await until(() => f.session.executionState === "stopped" && !f.session.busy);
        if (terminal !== "close") await f.session.flush();
        assert.equal(await value("pagent.executionState"), "stopped");
        const before = f.requests.length;
        await value("document.body.innerHTML = '<article>terminal world</article>'");
        assert.equal(await value("originals.some(a => a.isConnected)"), false);
        await delay(50);
        assert.equal(f.requests.slice(before).filter(request => request.type === "submit" || request.type === "register").length, 0);
        assert.equal(f.session.executionState, "stopped");
      } finally { await f.close(); }
    });
  }

  test(`${browser}: real reload gates persistence before navigation and never restarts inference`, { timeout: 45_000 }, async () => {
    const f = await fixture(browser);
    const value = (expression: string) => f.session.browser.evaluateValue(expression);
    try {
      await value(`window.originals = pagent.agents; window.removals = 0;
        aos.addEventListener('event', event => {
          if (event.detail.event.type === 'workspace-state' && event.detail.event.reloading) {
            document.body.innerHTML = '<article>reload world</article>';
            queueMicrotask(() => queueMicrotask(() => { removals = originals.filter(a => a.isConnected).length; }));
          }
        });`);
      const before = f.requests.length;
      await f.session.browser.reload();
      await f.session.flush();
      assert.equal(await value("typeof originals"), "undefined", "new document replaces the old runtime");
      assert.equal(await value("pagent.agents.length"), 6);
      assert.equal(await value("pagent.agents.every(a => !a.run && !a.messages.length)"), true);
      assert.equal(f.requests.slice(before).filter(request => request.type === "dispose").length, 6, "old persistent elements disposed instead of recovering during the reload gate");
      assert.equal(f.requests.slice(before).filter(request => request.type === "submit").length, 0);
    } finally { await f.close(); }
  });
}
