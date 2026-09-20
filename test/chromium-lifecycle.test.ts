import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchChromium } from "../src/chromium.ts";
import { Cdp, object } from "pi-browser/cdp";
import type { PageBrowser } from "../src/protocol.ts";

async function eventually(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), "expected browser event within 3 seconds");
}

test("Chromium owns one page, leaves other tabs unconnected, and reports human closure once", { timeout: 30_000 }, async () => {
  const profile = await mkdtemp(path.join(tmpdir(), "pagent-chromium-lifecycle-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end("<!doctype html><main>workspace</main><script>if(window.aos)aos.send({type:'ready',after:0,agents:['main']})</script>");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  let page: PageBrowser | undefined;
  let connection: Cdp | undefined;
  let other: Cdp | undefined;
  try {
    const requests: unknown[] = [];
    let closures = 0;
    page = await launchChromium({ profileDir: profile, url, headless: true,
      noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1",
      onRequest: request => requests.push(request), onClose: () => { closures++; } });
    await eventually(() => requests.length === 1);
    const [port, socketPath] = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).trim().split("\n");
    connection = await Cdp.connect(`ws://127.0.0.1:${port}${socketPath}`);
    const response = await connection.request("Target.getTargets");
    assert(Array.isArray(response.targetInfos));
    const pages = response.targetInfos.map(object).filter(target => target.type === "page");
    assert.equal(pages.length, 1);
    const target = pages[0];
    // A manually opened tab at the workspace origin is still not agent-connected.
    const created = await connection.request("Target.createTarget", { url });
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{ id: string; webSocketDebuggerUrl: string }>;
    const unconnected = targets.find(candidate => candidate.id === created.targetId);
    assert(unconnected);
    other = await Cdp.connect(unconnected.webSocketDebuggerUrl);
    const probe = await other.request("Runtime.evaluate", { expression: "typeof window.aos", returnByValue: true });
    assert.equal(object(probe.result).value, "undefined");
    assert.equal(requests.length, 1);
    await connection.request("Target.closeTarget", { targetId: created.targetId });
    assert.equal(closures, 0);
    assert.equal(await page.evaluateValue("typeof aos.send"), "function");
    await connection.request("Target.closeTarget", { targetId: target.targetId });
    await eventually(() => closures === 1);
    await assert.rejects(page.evaluateValue("1"), /closed/);
    await page.close();
    await page.close();
    assert.equal(closures, 1, "explicit cleanup does not repeat human closure");
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) }));
  } finally {
    other?.close();
    connection?.close();
    await page?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(profile, { recursive: true, force: true, maxRetries: 3 });
  }
});
