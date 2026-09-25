import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import { validateBrowserPolicy } from "../src/browser-policy.ts";
import { startServer } from "../src/server.ts";
import { openWorkspace } from "../src/storage.ts";
import type { BrowserLog, PageBrowser } from "../src/protocol.ts";

const HTML = '<!doctype html><html data-original="yes"><head><script src="/bootstrap.js"></script></head><body><p-agent id="one"></p-agent></body></html>';
const SCRIPT = `customElements.define('p-agent', class extends HTMLElement {
  constructor() { super(); this.attachShadow({mode:'open',serializable:true}).innerHTML = '<p>private shadow history</p>'; }
});
window.received = [];
aos.addEventListener('event', event => { received.push(event.detail); console.info('real receiver'); event.ack(); });
aos.send({type:'ready',after:0,agents:['one']});`;

test("validates reusable viewport and network policy", () => {
  for (const viewport of [{ width: 0, height: 100 }, { width: 1.5, height: 100 }, { width: 100, height: 8193 }]) {
    assert.throws(() => validateBrowserPolicy({ viewport }), /Viewport/);
  }
  assert.throws(() => validateBrowserPolicy({ network: "bad" as "open" }), /Network policy/);
  validateBrowserPolicy({ viewport: { width: 800, height: 600 }, network: "local" });
});

for (const engine of ["chromium", "firefox"] as const) {
  for (const csp of [true, false]) {
    test(`${engine} local networking${csp ? " with CSP" : " interception alone"}, fixed viewport and silent isolated capture`, { timeout: 45_000 }, async t => {
      const root = await mkdtemp(path.join(os.tmpdir(), `pagent-local-${engine}-`));
      const templateDir = path.join(root, "template");
      await mkdir(templateDir);
      await writeFile(path.join(templateDir, "index.html"), HTML);
      await writeFile(path.join(templateDir, "bootstrap.js"), SCRIPT);
      await writeFile(path.join(templateDir, "prompt.md"), "Your environment is this page.");
      const workspace = await openWorkspace({ directory: path.join(root, "workspace"), templateDir });
      const server = await startServer(workspace, { http: ["GET"], network: csp ? "local" : "open" });
      const reached: string[] = [];
      const sentinel = createServer((request, response) => {
        reached.push(request.url ?? "");
        response.writeHead(200, { "Access-Control-Allow-Origin": "*", "Content-Type": "text/javascript" });
        response.end("export const external = true;");
      });
      await new Promise<void>(resolve => sentinel.listen(0, "127.0.0.1", resolve));
      const address = sentinel.address();
      assert.ok(address && typeof address !== "string");
      const external = `http://127.0.0.1:${address.port}`;
      const requests: unknown[] = [];
      const logs: BrowserLog[] = [];
      let page: PageBrowser | undefined;
      t.after(async () => {
        await page?.close();
        await server.close();
        await workspace.close();
        sentinel.closeAllConnections();
        await new Promise<void>(resolve => sentinel.close(() => resolve()));
        await rm(root, { recursive: true, force: true });
      });
      page = await launchBrowser({ browser: engine, profileDir: path.join(root, "profile"), headless: true,
        url: server.url, network: "local", viewport: { width: 800, height: 600 },
        ...(engine === "chromium" ? { noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1" } : {}),
        onRequest: request => requests.push(request), onConsole: entry => logs.push(entry), onError: () => {},
      });
      assert.deepEqual(await page.evaluateValue("[innerWidth, innerHeight]"), [800, 600]);
      assert.equal(requests.length, 1, "bootstrap script and native bridge work");
      const reads = await page.evaluate(`(async () => ({
        prompt: await (await fetch('/prompt.md')).text(),
        listing: await (await fetch('/?list')).json(),
        write: (await fetch('/prompt.md', {method:'POST',body:'changed'})).status
      }))()`);
      assert.equal(reads.error, undefined);
      assert.deepEqual(reads.value, {
        prompt: "Your environment is this page.",
        listing: [
          { name: "bootstrap.js", type: "file", size: Buffer.byteLength(SCRIPT) },
          { name: "index.html", type: "file", size: Buffer.byteLength(HTML) },
          { name: "prompt.md", type: "file", size: 30 },
        ],
        write: 405,
      });
      const probes = await page.evaluate(`Promise.all([
        fetch(${JSON.stringify(external + "/fetch")}).then(() => 'reached', () => 'blocked'),
        import(${JSON.stringify(external + "/module.js")}).then(() => 'reached', () => 'blocked'),
        new Promise(resolve => { const image = new Image(); image.onload = () => resolve('reached'); image.onerror = () => resolve('blocked'); image.src = ${JSON.stringify(external + "/image")}; document.body.append(image); })
      ])`);
      assert.equal(probes.error, undefined);
      assert.deepEqual(probes.value, ["blocked", "blocked", "blocked"]);
      await page.evaluateValue(`window.open(${JSON.stringify(external + "/popup")});`);
      await delay(200);
      assert.deepEqual(reached, [], "external fetch, module, image and popup never reach sentinel");
      await page.evaluateValue("window.frameMarker = 'live'; Element.prototype.getHTML = () => 'tampered';");
      const waiting = page.evaluate("new Promise(resolve => { window.finish = resolve; console.log('waiting'); })");
      try {
        for (let i = 0; i < 100 && !logs.some(entry => entry.text === "waiting"); i++) await delay(10);
        assert.ok(logs.some(entry => entry.text === "waiting"));
        assert.ok(page.captureFrame);
        const frame = await page.captureFrame({ screenshot: true });
        assert.match(frame.html, /^<!DOCTYPE html>/i);
        assert.match(frame.html, /data-original="yes"/);
        assert.match(frame.html, /shadowrootserializable/);
        assert.match(frame.html, /private shadow history/);
        assert.ok(frame.screenshot?.startsWith("iVBORw0K"));
        assert.equal(await page.evaluateValue("received.length"), 0, "capture emits no saved or other page event");
        assert.equal(await page.evaluateValue("frameMarker"), "live", "capture does not reset live state");
        await page.deliver({ seq: 1, event: { type: "error", message: "synthetic marker" } });
        assert.ok(logs.some(entry => entry.synthetic && entry.text.includes("synthetic marker")));
        assert.ok(logs.some(entry => !entry.synthetic && entry.text === "real receiver"));
      } finally {
        await page.evaluateValue("finish(7)");
        const result = await waiting;
        assert.equal(result.value, 7);
        assert.ok(!result.logs.some(line => line.includes("synthetic marker")));
      }
    });
  }
}
