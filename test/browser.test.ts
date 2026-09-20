import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import type { HostEvent, PageBrowser } from "../src/protocol.ts";

const INITIAL_HTML = `<!DOCTYPE html><html lang="en" data-preserve="yes"><head><title>Browser VM test</title></head><body>
<test-panel></test-panel><main id="workspace">initial</main>
<script>
customElements.define("test-panel", class extends HTMLElement {
  constructor() {
    super();
    const root = this.shadowRoot ?? this.attachShadow({mode:"open",serializable:true});
    if (!root.childNodes.length) root.innerHTML = '<p id="inside">shadow data</p>';
  }
});
window.received = [];
window.aos.addEventListener("event", event => { window.received.push(event.detail); event.ack(); });
window.aos.send({type:"ready",after:0,agents:["main"]});
</script></body></html>`;

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), message);
}

test("persistent Chromium VM and native page bridge", { timeout: 70_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pagent-browser-test-"));
  let html = INITIAL_HTML;
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/`;
  const requests: unknown[] = [];
  const errors: Error[] = [];
  let browser: PageBrowser | undefined;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  browser = await launchBrowser({
    profileDir: directory, url, headless: true,
    noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1",
    onRequest: request => requests.push(request), onError: error => errors.push(error),
  });
  const page = browser;

  await t.test("loopback origin, persistent globals, top-level await and logs", async () => {
    assert.equal(await page.evaluateValue("location.origin"), new URL(url).origin);
    await eventually(() => requests.length === 1, "document sends ready through native binding");
    const first = await page.evaluate('let counter = 40; console.log("count", counter); await Promise.resolve(++counter)');
    assert.equal(first.value, 41);
    assert.deepEqual(first.logs, ["log: count 40"]);
    assert.equal((await page.evaluate("++counter")).value, 42);
    assert.equal((await page.evaluate("let counter = 7; counter")).value, 7);
    assert.deepEqual((await page.evaluate("undefined")).value, { type: "undefined" });
    const failed = await page.evaluate('throw new Error("intentional failure")');
    assert.match(failed.error ?? "", /intentional failure/);
    assert.equal((await page.evaluate("counter")).value, 7);
    const promised = await page.evaluate('(async () => { await new Promise(r => setTimeout(r, 20)); return ++counter; })()');
    assert.equal(promised.value, 8, 'await an IIFE completion without executing it twice');
    assert.equal((await page.evaluate('counter')).value, 8);
    assert.deepEqual((await page.evaluate('Promise.resolve({answer:42})')).value, { answer: 42 });
    assert.match((await page.evaluate('Promise.reject(new Error("async failure"))')).error ?? '', /async failure/);
  });

  await t.test("internal evaluations and delivery stay independent of console execution", async () => {
    const pending = page.evaluate('await new Promise(resolve => { window.finishEval = resolve; }); console.log("agent log"); 9');
    await delay(30);
    await page.evaluateValue('console.log("internal log"); window.finishEval()');
    const result = await pending;
    assert.equal(result.value, 9);
    assert.deepEqual(result.logs, ["log: internal log", "log: agent log"]);
  });

  await t.test("host events and isolation from frame bindings", async () => {
    const event = { seq: 12, event: { type: "saved" as const, revision: "revision-12" } };
    await page.deliver(event);
    assert.deepEqual(await page.evaluateValue("window.received"), [event]);
    const dataEvent: HostEvent = { seq: 13, event: { type: 'tool', phase: 'end', callId: 'data', name: 'console',
      result: JSON.parse('{"__proto__":{"inherited":"bad"},"ok":1}') } };
    await page.deliver(dataEvent);
    assert.deepEqual(JSON.parse(String(await page.evaluateValue('JSON.stringify(received.at(-1))'))), dataEvent);
    assert.equal(await page.evaluateValue('Object.hasOwn(received.at(-1).event.result, "__proto__") && Object.getPrototypeOf(received.at(-1).event.result) === Object.prototype'), true);
    await page.evaluateValue(`(() => {
      const iframe = document.createElement("iframe");
      iframe.srcdoc = '<script>__pagentSend(JSON.stringify({type:"submit",agentId:"main",id:"from-frame",runId:"frame-run"}))<\\/script>';
      document.body.append(iframe);
    })()`);
    await delay(200);
    assert.equal(requests.length, 1, "iframe cannot submit native input");
    await page.evaluateValue('window.aos.send({type:"submit",agentId:"main",id:"from-main",runId:"main-run"})');
    await eventually(() => requests.length === 2, "main-page submission arrives");
  });

  await t.test("serialization includes root attributes, doctype and serializable shadow DOM", async () => {
    await page.evaluateValue('document.querySelector("#workspace").textContent = "persisted"');
    html = await page.snapshot();
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /data-preserve="yes"/);
    assert.match(html, /shadowrootmode="open"/);
    assert.match(html, /shadowrootserializable/);
    assert.match(html, /shadow data/);
    await page.reload();
    assert.equal(await page.evaluateValue('document.querySelector("#workspace").textContent'), "persisted");
    assert.equal(await page.evaluateValue('document.querySelector("test-panel").shadowRoot.textContent'), "shadow data");
    assert.equal(await page.evaluateValue('typeof counter'), "undefined", "heap is reset by reload");
    await eventually(() => requests.filter(request => (request as { type: string }).type === "ready").length === 2, "bridge reinjected before saved page scripts");
    assert.equal((await page.screenshot()).slice(0, 8), "iVBORw0K");
  });

  await t.test("hung synchronous evaluation is terminated and page remains usable", async () => {
    await assert.rejects(page.evaluate("while (true) {}", { timeoutMs: 150 }), /terminated|timed out/i);
    assert.equal((await page.evaluate("1 + 1")).value, 2);
  });

  await t.test("abort and never-settling awaited promises do not block later commands", async () => {
    const controller = new AbortController();
    const waiting = page.evaluate("await new Promise(() => {})", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(waiting, /cancelled/i);
    assert.equal((await page.evaluate("3 + 4")).value, 7);
    await assert.rejects(page.evaluate("await new Promise(() => {})", { timeoutMs: 100 }), /timed out/i);
    assert.equal((await page.evaluate("5 + 6")).value, 11);
  });

  await t.test("outside-origin top-level navigation is blocked and explicit reload recovers", async () => {
    await page.evaluateValue(`location.href = "http://localhost:${address.port}/"`).catch(() => {});
    await eventually(() => errors.some(error => /navigation outside/.test(error.message)), "foreign navigation reported");
    await page.reload();
    assert.equal(await page.evaluateValue("location.origin"), new URL(url).origin);
  });

  await t.test("closing terminates the owned process", async () => {
    const portFile = await readFile(path.join(directory, "DevToolsActivePort"), "utf8");
    const port = Number(portFile.split("\n")[0]);
    await page.close();
    await assert.rejects(fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1_000) }));
    await assert.rejects(page.evaluateValue("1"), /closed/);
    await page.close();
  });
});
