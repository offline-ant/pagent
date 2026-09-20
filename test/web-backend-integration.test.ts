import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { WebBackend } from "pi-browser/web";
import { startPagent, type PagentApp, type PagentSession } from "../src/app.ts";
import { readWebBackendOverride } from "../src/web-backend.ts";

async function waitFor(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(20);
  }
  throw new Error("Timed out waiting for native backend state");
}

async function select(session: PagentSession, override: WebBackend | null): Promise<void> {
  await session.browser.evaluateValue(`(() => {
    const select = $(\"#main\").shadowRoot.querySelector('[data-web-backend]');
    select.value = ${JSON.stringify(override ?? "")};
    select.dispatchEvent(new Event('change'));
  })()`);
  await waitFor(async () => await session.browser.evaluateValue(`$(\"#main\").webBackend?.override === ${JSON.stringify(override)}`) === true);
  assert.equal(session.getBackendState().override, override);
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} native backend control validates, persists and reconnects without inference`, { timeout: 75_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pagent-native-backend-"));
    let app: PagentApp | undefined;
    try {
      const options = { directory: root, port: 0, fake: true, headless: true, browser,
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" };
      app = await startPagent(options);
      const configured = app.getBackendState();
      assert.equal(configured.override, null);
      const originalHTML = await readFile(path.join(app.directory, "index.html"), "utf8");
      const originalScript = await readFile(path.join(app.directory, "agent.js"), "utf8");
      await select(app, "auto");
      assert.deepEqual(app.getBackendState(), { ...configured, override: "auto", effective: "auto", source: "override" });
      assert.equal(await readWebBackendOverride(app.stateDirectory), "auto");
      assert.equal(await readFile(path.join(app.directory, "index.html"), "utf8"), originalHTML, "backend changes persist without saving the conversation");
      for (const request of [{ type: "backend-set" }, ...["invalid", "", false, 1, {}, ["browser"]].map(override => ({ type: "backend-set", override }))]) {
        const seq = await app.browser.evaluateValue("$(\"#main\").lastSeq");
        await app.browser.evaluateValue(`aos.send(${JSON.stringify(request)})`);
        await waitFor(async () => await app!.browser.evaluateValue(`$(\"#main\").lastSeq > ${seq} && $(\"#main\").state.notice.includes('Web backend override must be')`) === true);
        assert.equal(app.getBackendState().override, "auto");
        assert.equal(await readWebBackendOverride(app.stateDirectory), "auto");
      }
      await select(app, "browser");
      await app.save();
      await select(app, null);
      await app.browser.reload(); // Saved markup and replay can contain the old Browser override.
      await app.flush();
      assert.deepEqual(await app.browser.evaluateValue("$(\"#main\").webBackend"), configured);
      assert.equal(await app.browser.evaluateValue("$(\"#main\").shadowRoot.querySelector('[data-web-backend]').value"), "");
      await app.browser.evaluateValue(`(() => {
        $(\"#main\").webBackend = {configured:'auto',override:'codex',effective:'codex',source:'override'};
        $(\"#main\").refresh();
        aos.send({type:'ready',agents:pagent.agents.map(a=>a.id),after:$(\"#main\").lastSeq});
      })()`);
      await waitFor(async () => await app!.browser.evaluateValue("$(\"#main\").webBackend?.override === null") === true);
      assert.deepEqual(await app.browser.evaluateValue("$(\"#main\").webBackend"), configured, "reconnect republishes authoritative backend state");
      assert.equal(app.agents.get("main")!.busy, false);
      assert.deepEqual(await app.browser.evaluateValue("pagent.collectContext(\"main\").history"), []);
      assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs.length"), 0, "native controls never invoke the model");
      assert.equal(await readFile(path.join(app.directory, "agent.js"), "utf8"), originalScript, "existing directory resources remain untouched");
      await select(app, "codex");
      await app.close();
      const otherBrowser = browser === "chromium" ? "firefox" : "chromium";
      app = await startPagent({ ...options, browser: otherBrowser,
        noSandbox: otherBrowser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", restore: "latest", log() {} });
      assert.equal(app.getBackendState().override, "codex", "preferences survive restart, engine switching, and HTML recovery");
      assert.equal(await app.browser.evaluateValue("$(\"#main\").webBackend.override"), "codex");
      await select(app, null);
      await app.close();
      app = await startPagent({ ...options, resetUI: true, log() {} });
      assert.deepEqual(app.getBackendState(), configured, "reset is durable and independent of UI recovery");
      assert.deepEqual(await app.browser.evaluateValue("pagent.collectContext(\"main\").history"), []);
    } finally {
      await app?.close();
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
}
