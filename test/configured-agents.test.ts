import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
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
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error("Configured agent condition timed out.");
}

async function fixture(browserKind: BrowserKind, html: string, settings: Partial<SessionOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pagent-configured-"));
  const workspace = await openWorkspace({ directory, templateDir: fileURLToPath(new URL("../template/", import.meta.url)) });
  await workspace.write("/prompt.md", Buffer.from("Exact operator instructions.\nOnly this prompt."));
  await workspace.write("/index.html", Buffer.from(`<!doctype html><html><head><script type="module" src="/agent.js"></script></head><body>${html}</body></html>`));
  const original = await workspace.read("/");
  const server = await startServer(workspace);
  let browser: PageBrowser | undefined;
  let session: PagentSession | undefined;
  const logs: string[] = [];
  async function close() {
    await session?.close(); await browser?.close(); await server.close(); await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    session = await startSession({ workspace, url: server.url, browserKind, fake: true, checkpoint: "private",
      log: message => logs.push(message), onClose: () => {}, ...settings,
      createBrowser: async options => {
        browser = await launchBrowser({ ...options, browser: browserKind, headless: true, profileDir: join(workspace.stateDirectory, browserKind),
          noSandbox: browserKind === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" });
        return browser;
      },
    });
    return { session, workspace, logs, original, close };
  } catch (error) { await close(); throw error; }
}

test("a cancelled scheduled prompt queued in the browser cannot reach inference", { timeout: 30_000 }, async () => {
  const value = await fixture("chromium", '<p-agent id="one" mode="continuous" repeat-prompt="/fake-say again"></p-agent>', {
    checkpoint: "none", tools: [], repeatDelayMs: 20,
  });
  const { session } = value;
  const evaluate = session.browser.evaluateValue.bind(session.browser);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const engine = session.agents.get("one")!;
  const submit = engine.submit.bind(engine);
  const cancel = engine.cancel.bind(engine);
  let submissions = 0;
  let queued = false;
  engine.submit = input => { submissions++; return submit(input); };
  engine.cancel = async () => { cancelled.resolve(); await cancel(); };
  session.browser.evaluateValue = async expression => {
    if (!queued && expression.includes("agent.prompt(")) {
      queued = true;
      entered.resolve();
      await release.promise;
    }
    return evaluate(expression);
  };
  try {
    const starting = session.start();
    await entered.promise;
    await evaluate("aos.send({type:'cancel',agentId:'one'})");
    await cancelled.promise;
    release.resolve();
    await starting;
    await until(async () => await evaluate("$('#one').run?.status === 'cancelled'") === true);
    await delay(100);
    assert.equal(submissions, 0);
    assert.equal(session.busy, false);
    await session.start();
    await until(() => submissions > 0);
  } finally {
    release.resolve();
    session.browser.evaluateValue = evaluate;
    engine.cancel = cancel;
    await value.close();
  }
});

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} configured prompt/tool selection is exact, immutable while attached, and preserves original source`, { timeout: 45_000 }, async () => {
    const fixtureValue = await fixture(browser, '<p-agent id="one" system-prompt="./prompt.md" tools="console"></p-agent><p-agent id="two" tools=""></p-agent>', { tools: ["console", "wait"], network: "local", http: ["GET", "HEAD"] });
    const { session, workspace, original } = fixtureValue;
    try {
      await session.browser.evaluateValue(`$('#one').prompt('/fake-inspect')`);
      await until(async () => await session.browser.evaluateValue(`$('#one').run?.status === 'complete'`) === true);
      const inspected = JSON.parse(String(await session.browser.evaluateValue(`$('#one').result`))) as { systemPrompt: string; tools: { name: string }[] };
      assert.equal(inspected.systemPrompt, "Exact operator instructions.\nOnly this prompt.");
      assert.deepEqual(inspected.tools.map(tool => tool.name), ["console"]);
      assert.equal(await session.browser.evaluateValue(`$('#one').shadowRoot.querySelector('[data-save]').hidden`), true);
      await session.browser.evaluateValue(`$('#one').setAttribute('system-prompt', 'other.md')`);
      assert.equal(await session.browser.evaluateValue(`$('#one').getAttribute('system-prompt')`), "./prompt.md");
      assert.match(String(await session.browser.evaluateValue(`$('#one').state.notice`)), /pinned/);
      await session.browser.evaluateValue(`$('#two').prompt('/fake-inspect')`);
      await until(async () => await session.browser.evaluateValue(`$('#two').run?.status === 'complete'`) === true);
      const second = JSON.parse(String(await session.browser.evaluateValue(`$('#two').result`))) as { tools: unknown[] };
      assert.deepEqual(second.tools, []);
      for (const type of ["save", "reload", "backend-set"]) {
        await session.browser.evaluateValue(`aos.send({type:${JSON.stringify(type)},override:'browser'})`);
        await until(async () => String(await session.browser.evaluateValue(`$('#one').state.notice`)).includes("disabled by host policy"));
      }
      assert.deepEqual(await workspace.read("/"), original);
      await session.save();
      assert.deepEqual(await workspace.read("/"), original);
      await symlink(join(workspace.directory, "prompt.md"), join(workspace.directory, "linked.md"));
      await session.browser.evaluateValue(`(() => { const a=document.createElement('p-agent'); a.id='linked'; a.setAttribute('system-prompt','./linked.md'); document.body.append(a); })()`);
      await until(async () => String(await session.browser.evaluateValue(`$('#linked').state.notice`)).includes("Resource must be a regular file"));
    } finally { await fixtureValue.close(); }
  });

  test(`${browser} continuous kickoff repeats settled runs and deadline rejects every native submission path`, { timeout: 45_000 }, async () => {
    let starts = 0;
    let stops = 0;
    const fixtureValue = await fixture(browser, '<p-agent id="one" mode="continuous" repeat-prompt="/fake-say one"></p-agent><p-agent id="two" mode="continuous" repeat-prompt="/fake-say two"></p-agent>', {
      durationMs: browser === "firefox" ? 4000 : 1000, repeatDelayMs: 60, checkpoint: "none", tools: ["console"],
      onExecutionStart: async () => { starts++; }, onExecutionStop: async () => { stops++; },
    });
    const { session, workspace, original } = fixtureValue;
    try {
      assert.equal(session.executionState, "armed");
      assert.equal(session.busy, false);
      await session.browser.evaluateValue(`pagent.start()`);
      await until(() => session.executionState === "running");
      await until(async () => await session.browser.evaluateValue(`pagent.agents.every(a => a.messages.filter(m => m.role === 'user').length >= 2)`) === true);
      await session.start();
      assert.equal(starts, 1);
      await until(() => session.executionState === "stopped" && !session.busy && stops === 1);
      await session.flush();
      const counts = await session.browser.evaluateValue(`JSON.stringify(pagent.agents.map(a => a.messages.length))`);
      await delay(200);
      assert.equal(await session.browser.evaluateValue(`JSON.stringify(pagent.agents.map(a => a.messages.length))`), counts);
      await session.browser.evaluateValue(`aos.send({type:'submit',agentId:'one',id:'blocked-input',runId:'blocked-run'})`);
      await session.flush();
      assert.equal(session.busy, false);
      await session.browser.evaluateValue(`aos.send({type:'register',agentId:'after-stop'})`);
      await session.browser.evaluateValue(`aos.send({type:'ready',after:0,agents:[{agentId:'after-ready'}]})`);
      await delay(50);
      assert.equal(session.agents.has("after-stop"), false);
      assert.equal(session.agents.has("after-ready"), false);
      assert.deepEqual(await workspace.read("/"), original);
      await assert.rejects(session.start(), /stopped/);
    } finally { await fixtureValue.close(); }
  });
}
