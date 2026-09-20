import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchFirefox } from "../src/firefox.ts";
import { remoteValue } from "pi-browser/bidi";
import type { HostEvent, PageBrowser } from "../src/protocol.ts";

const INITIAL_HTML = `<!DOCTYPE html><html lang="en" data-preserve="yes"><head><title>Firefox VM test</title></head><body>
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
if (window.aos) {
  window.aos.addEventListener("event", event => { window.received.push(event.detail); event.ack(); });
  window.aos.send({type:"ready",after:0,agents:["main"]});
}
</script></body></html>`;

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), message);
}

async function debugPort(directory: string): Promise<number> {
  const info = JSON.parse(await readFile(path.join(directory, "WebDriverBiDiServer.json"), "utf8")) as { ws_host: string; ws_port: number };
  assert.equal(info.ws_host, "127.0.0.1", "debugging is loopback-only");
  return info.ws_port;
}

async function portClosed(port: number): Promise<void> {
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1_000) }));
}

test("BiDi decoding preserves dangerous keys without changing prototypes", () => {
  const value = remoteValue({ type: "object", value: [["__proto__", { type: "object", value: [["polluted", { type: "boolean", value: true }]] }]] });
  assert.ok(value && typeof value === "object");
  assert.equal(Object.getPrototypeOf(value), Object.prototype);
  assert.deepEqual(Object.getOwnPropertyDescriptor(value, "__proto__")?.value, { polluted: true });
});

test("persistent Firefox VM and native page bridge", { timeout: 150_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pagent-firefox-test-"));
  let html = INITIAL_HTML;
  const network: string[] = [];
  let port = 0;
  const server = createServer((request, response) => {
    network.push(`${request.headers.host}${request.url}`);
    if (request.url === "/redirect") {
      response.writeHead(302, { Location: `http://localhost:${port}/redirect-target` });
      response.end();
      return;
    }
    response.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-store" });
    response.end(html);
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  port = address.port;
  const url = `http://127.0.0.1:${port}/`;
  const requests: unknown[] = [];
  const errors: Error[] = [];
  let browser: PageBrowser | undefined;
  t.after(async () => {
    await browser?.close();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  browser = await launchFirefox({
    profileDir: directory, url, headless: true,
    onRequest: request => requests.push(request), onError: error => errors.push(error),
  });
  let page = browser;

  await t.test("loopback origin, early ready, globals, promises, syntax limits and logs", async () => {
    assert.deepEqual(requests, [{ type: "ready", after: 0, agents: ["main"] }], "preload is installed before initial page scripts");
    assert.equal(await page.evaluateValue("location.origin"), new URL(url).origin);
    const first = await page.evaluate('let counter = 40; console.log("count", counter); Promise.resolve(++counter)');
    assert.equal(first.value, 41);
    assert.deepEqual(first.logs, ["log: count 40"]);
    assert.equal((await page.evaluate("++counter")).value, 42);
    assert.match((await page.evaluate("let counter = 7")).error ?? "", /redeclaration/);
    assert.match((await page.evaluate("await Promise.resolve(3)")).error ?? "", /SyntaxError.*await/);
    assert.equal((await page.evaluate("(async () => { await Promise.resolve(); return ++counter; })()")).value, 43);
    assert.deepEqual((await page.evaluate("undefined")).value, { type: "undefined" });
    assert.deepEqual((await page.evaluate("[1n, NaN, Infinity, -0]")).value, [
      { type: "bigint", value: "1" }, { type: "number", value: "NaN" },
      { type: "number", value: "Infinity" }, { type: "number", value: "-0" },
    ]);
    assert.deepEqual((await page.evaluate("(() => {const a = {}; a.self = a; return a;})()")).value, { self: { type: "object", truncated: true } });
    assert.match((await page.evaluate('throw new Error("intentional failure")')).error ?? "", /intentional failure/);
    assert.match((await page.evaluate('Promise.reject(new Error("promise failure"))')).error ?? "", /promise failure/);
    assert.equal((await page.evaluate("counter")).value, 43);
  });

  await t.test("internal evaluations and host delivery remain independent", async () => {
    const pending = page.evaluate('(async () => { await new Promise(resolve => { window.finishEval = resolve; }); console.log("agent log"); return 9; })()');
    await delay(50);
    const event = { seq: 12, event: { type: "saved" as const, revision: "revision-12" } };
    await page.deliver(event);
    assert.deepEqual(await page.evaluateValue("window.received"), [event]);
    const dataEvent: HostEvent = { seq: 13, event: { type: 'tool', phase: 'end', callId: 'data', name: 'console',
      result: JSON.parse('{"__proto__":{"inherited":"bad"},"ok":1}') } };
    await page.deliver(dataEvent);
    assert.deepEqual(JSON.parse(String(await page.evaluateValue('JSON.stringify(received.at(-1))'))), dataEvent);
    assert.equal(await page.evaluateValue('Object.hasOwn(received.at(-1).event.result, "__proto__") && Object.getPrototypeOf(received.at(-1).event.result) === Object.prototype'), true);
    await page.evaluateValue('console.log("internal log"); window.finishEval()');
    const result = await pending;
    assert.equal(result.value, 9);
    assert.deepEqual(result.logs, ["log: internal log", "log: agent log"]);
  });

  await t.test("no frame or other-tab bridge, pinned root, main-page submission accepted", async () => {
    await page.evaluateValue(`Promise.all([
      (() => { const f = document.createElement('iframe'); document.body.append(f); return typeof f.contentWindow.aos; })(),
      ...['/same-frame', 'http://localhost:${address.port}/foreign-frame'].map(src => new Promise(resolve => {
        const f = document.createElement('iframe'); f.onload = () => resolve(); f.src = src; document.body.append(f);
      })),
      new Promise(resolve => { const f = document.createElement('iframe'); f.onload = () => resolve();
        f.srcdoc = '<script>if(window.aos)aos.send({type:"submit",agentId:"main",id:"srcdoc",runId:"frame-run"})<\\/script>'; document.body.append(f); })
    ])`);
    assert.deepEqual(await page.evaluateValue("Array.from(document.querySelectorAll('iframe')).filter(f => {try{return f.contentWindow.location.origin === location.origin || f.srcdoc || !f.src}catch{return false}}).map(f => typeof f.contentWindow.aos)"), ["undefined", "undefined", "undefined"]);
    await page.evaluateValue(`window.open(${JSON.stringify(url + "other-tab")}); window.rootMarker = 'pinned'`);
    await delay(250);
    assert.equal(await page.evaluateValue("window.rootMarker"), "pinned");
    assert.equal(requests.length, 1, "neither subframes nor additional top-level tabs send ready");
    await page.evaluateValue('window.aos.send({type:"submit",agentId:"main",id:"from-main",runId:"main-run"})');
    await eventually(() => requests.length === 2, "main-page submission arrives");
    await page.evaluateValue("document.querySelectorAll('iframe').forEach(frame => frame.remove())");
  });

  await t.test("snapshot preserves doctype, root attributes and declarative shadow DOM", async () => {
    await page.evaluateValue('document.querySelector("#workspace").textContent = "persisted"; localStorage.setItem("profile-state", "retained")');
    html = await page.snapshot();
    assert.match(html, /^<!DOCTYPE html>/i);
    assert.match(html, /data-preserve="yes"/);
    assert.match(html, /shadowrootmode="open"/);
    assert.match(html, /shadowrootserializable/);
    assert.match(html, /shadow data/);
    await page.reload();
    assert.equal(await page.evaluateValue('document.querySelector("#workspace").textContent'), "persisted");
    assert.equal(await page.evaluateValue('document.querySelector("test-panel").shadowRoot.textContent'), "shadow data");
    assert.equal(await page.evaluateValue("typeof counter"), "undefined");
    assert.equal(await page.evaluateValue('localStorage.getItem("profile-state")'), "retained");
    await eventually(() => requests.filter(request => (request as { type: string }).type === "ready").length === 2, "reload reinjects bridge");
    await page.evaluateValue('aos.send({type:"save"})');
    await eventually(() => requests.some(request => (request as { type: string }).type === "save"), "reloaded channel remains usable");
    assert.equal((await page.screenshot()).slice(0, 8), "iVBORw0K");
  });

  await t.test("foreign main navigation and redirects blocked before reaching server", async () => {
    await page.evaluateValue(`location.href = "http://localhost:${address.port}/blocked-main"`).catch(() => {});
    await eventually(() => errors.some(error => /navigation outside.*blocked-main/.test(error.message)), "foreign navigation reported");
    assert.ok(!network.some(request => request.endsWith("/blocked-main")));
    await page.reload();
    await page.evaluateValue('location.href = "/redirect"').catch(() => {});
    await eventually(() => errors.some(error => /navigation outside.*redirect-target/.test(error.message)), "foreign redirect reported");
    assert.ok(!network.some(request => request.endsWith("/redirect-target")));
    await page.reload();
    assert.equal(await page.evaluateValue("location.href"), url);
  });

  await t.test("normal restart preserves saved workspace and profile storage", async () => {
    await page.close();
    browser = await launchFirefox({ profileDir: directory, url, headless: true, onRequest: request => requests.push(request), onError: error => errors.push(error) });
    page = browser;
    assert.equal(await page.evaluateValue('localStorage.getItem("profile-state")'), "retained");
    assert.equal(await page.evaluateValue('document.querySelector("#workspace").textContent'), "persisted");
  });

  for (const [name, code, cancel] of [
    ["timeout infinite loop", "while (true) {}", false],
    ["cancel infinite loop", "while (true) {}", true],
    ["timeout pending promise", "new Promise(() => {})", false],
    ["cancel pending promise", "new Promise(() => {})", true],
  ] as const) {
    await t.test(`${name} stops owned runtime, loses unsaved state, recovers same object`, async () => {
      const port = await debugPort(directory);
      const readyBefore = requests.filter(request => (request as { type: string }).type === "ready").length;
      await page.evaluateValue('window.unsaved = 123; document.querySelector("#workspace").textContent = "unsaved"');
      const controller = new AbortController();
      const started = Date.now();
      const pending = page.evaluate(code, { timeoutMs: cancel ? 5_000 : 100, signal: controller.signal });
      const timer = cancel ? setTimeout(() => controller.abort(), 100) : undefined;
      try { await assert.rejects(pending, cancel ? /cancelled; Firefox runtime reset.*unsaved DOM/ : /timed out.*Firefox runtime reset.*unsaved DOM/); }
      finally { clearTimeout(timer); }
      assert.ok(Date.now() - started < 20_000, "cancellation/relaunch is bounded");
      await portClosed(port);
      assert.equal((await page.evaluate("3 + 4")).value, 7);
      assert.equal(await page.evaluateValue("typeof unsaved"), "undefined");
      assert.equal(await page.evaluateValue('document.querySelector("#workspace").textContent'), "persisted");
      assert.equal(await page.evaluateValue('localStorage.getItem("profile-state")'), "retained");
      await eventually(() => requests.filter(request => (request as { type: string }).type === "ready").length === readyBefore + 1, "runtime reset sends ready for replay");
      await page.deliver({ seq: 99, event: { type: "saved", revision: "replayed" } });
      assert.equal(await page.evaluateValue("received[0].seq"), 99);
    });
  }

  await t.test("internal runaway evaluation stops runtime until explicit recovery", async () => {
    const pending = page.evaluate("new Promise(() => {})", { timeoutMs: 20_000 });
    const checked = assert.rejects(pending, /Firefox runtime stopped.*unsaved state lost/);
    await delay(50);
    await assert.rejects(page.evaluateValue("while(true) {}"), /timed out.*Firefox runtime stopped.*unsaved state lost/);
    await checked;
    await assert.rejects(page.evaluateValue("1"), /context is unavailable/);
    await page.reload();
    assert.equal((await page.evaluate("6 * 7")).value, 42);
  });

  await t.test("already-aborted evaluation does not reset runtime", async () => {
    await page.evaluateValue("window.keep = 7");
    await assert.rejects(page.evaluate("window.keep = 8", { signal: AbortSignal.abort() }), /cancelled before execution/);
    assert.equal(await page.evaluateValue("window.keep"), 7);
  });

  await t.test("close terminates owned process, is idempotent", async () => {
    const port = await debugPort(directory);
    await page.close();
    await portClosed(port);
    await assert.rejects(page.evaluateValue("1"), /closed/);
    await page.close();
    browser = await launchFirefox({ profileDir: directory, url, headless: true, onRequest: request => requests.push(request) });
    assert.equal(await browser.evaluateValue('localStorage.getItem("profile-state")'), "retained");
    assert.equal(await browser.evaluateValue('document.querySelector("#workspace").textContent'), "persisted");
    await browser.close();
  });
});

test("cleanup never signals a process group through an already-exited child handle", async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pagent-firefox-reaped-"));
  const kill = process.kill.bind(process);
  const groups: number[] = [];
  t.mock.method(process, 'kill', (pid: number, signal?: string | number) => {
    if (pid < 0) groups.push(pid);
    return kill(pid, signal);
  });
  try {
    await assert.rejects(launchFirefox({ profileDir: directory, url: 'http://127.0.0.1/',
      headless: true, executable: '/bin/false', onRequest: () => {} }), /exited during startup/);
    assert.deepEqual(groups, [], 'a reaped launcher no longer proves ownership of its numeric PGID');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Firefox startup failure cleans owned process and rejects sandbox opt-out", { timeout: 40_000 }, async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pagent-firefox-failure-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const options = { profileDir: path.join(directory, "profile"), url: "http://127.0.0.1:1/", headless: true, onRequest: () => {} };
  await assert.rejects(launchFirefox({ ...options, noSandbox: true }), /noSandbox/);
  await assert.rejects(launchFirefox({ ...options, executable: path.join(directory, "absent") }), /executable not found/);
  await assert.rejects(launchFirefox({ ...options, executable: "/bin/false" }), /exited during startup/);
  const wrapper = path.join(directory, "firefox-wrapper");
  const pidFile = path.join(directory, "pid");
  await writeFile(wrapper, `#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec '${process.env.FIREFOX_BINARY ?? "firefox"}' "$@"\n`, { mode: 0o700 });
  await assert.rejects(launchFirefox({ ...options, executable: wrapper }), /navigation|neterror|unknown error|address|denied|restricted/i);
  const pid = Number(await readFile(pidFile, "utf8"));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  await eventually(() => {
    try { process.kill(-pid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }, "owned process group is gone");
});
