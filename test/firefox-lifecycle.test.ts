import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchFirefox } from "../src/firefox.ts";
import { FirefoxPage } from "../src/firefox-page.ts";
import type { PageBrowser } from "../src/protocol.ts";

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-firefox-lifecycle-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end("<!doctype html><p>saved</p><script>if(window.aos)aos.send({type:'ready',after:0,agents:['main']})</script>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  return {
    directory, url: `http://127.0.0.1:${address.port}/`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test("Firefox owns one page and reports human closure once", { timeout: 30_000 }, async () => {
  const f = await fixture();
  let page: PageBrowser | undefined;
  let closed = 0;
  try {
    page = await launchFirefox({ profileDir: f.directory, url: f.url, headless: true, onRequest: () => {}, onClose: () => { closed++; } });
    assert(page instanceof FirefoxPage && page.state);
    const tree = await page.state.runtime.bidi.request("browsingContext.getTree");
    assert(Array.isArray(tree.contexts));
    assert.equal(tree.contexts.length, 1);
    // Firefox's BiDi close is a no-op for the last tab. Leave an ordinary,
    // unconnected browser tab open while simulating closure of the workspace.
    await page.state.runtime.bidi.request("browsingContext.create", { type: "tab" });
    await page.state.runtime.bidi.request("browsingContext.close", { context: page.state.context });
    const deadline = Date.now() + 3_000;
    while (!closed && Date.now() < deadline) await delay(20);
    assert.equal(closed, 1);
    await assert.rejects(page.evaluateValue("1"), /closed/);
    await page.close();
    await page.close();
    assert.equal(closed, 1);
  } finally { await page?.close(); await f.close(); }
});

for (const attachFirst of [false, true]) {
  test(`Firefox close during recovery ${attachFirst ? "after" : "before"} page attach releases the process`, { timeout: 30_000 }, async () => {
    const f = await fixture();
    let page: PageBrowser | undefined;
    let resume: () => void = () => {};
    try {
      let closures = 0;
      page = await launchFirefox({ profileDir: f.directory, url: f.url, headless: true, onRequest: () => {}, onClose: () => { closures++; } });
      assert(page instanceof FirefoxPage);
      const firefox = page;
      const attach = firefox.attach.bind(firefox);
      let attaching: () => void = () => {};
      const entered = new Promise<void>(resolve => { attaching = resolve; });
      const resumed = new Promise<void>(resolve => { resume = resolve; });
      firefox.attach = async (runtime, context) => {
        if (attachFirst) await attach(runtime, context);
        attaching();
        await resumed;
        if (!attachFirst) await attach(runtime, context);
      };
      const reset = assert.rejects(page.evaluate("while(true){}", { timeoutMs: 100 }), /Firefox runtime stopped|controlled browser is closed/);
      await entered;
      const closing = page.close();
      resume();
      await Promise.all([closing, reset]);
      assert.equal(firefox.owner.runtime, undefined);
      assert.equal(closures, 0, "explicit close and recovery are not human closure");
      await assert.rejects(page.evaluateValue("1"), /closed/);
    } finally { resume(); await page?.close(); await f.close(); }
  });
}
