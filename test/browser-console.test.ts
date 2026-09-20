import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import { chromiumConsoleText, firefoxConsoleText, syntheticConsole, logLocation } from "../src/browser-log.ts";
import { DiagnosticBuffer } from "../src/diagnostics.ts";
import type { BrowserLog, PageBrowser } from "../src/protocol.ts";

const SCRIPT = `console.log("startup-log");
console.info("startup-info");
console.warn("startup-warn");
console.error("startup-error-level");
console.debug("startup-debug");
console.trace("startup-trace");
window.getterReads = 0;
const cyclic = { answer: 42 };
cyclic.self = cyclic;
// BiDi itself serializes enumerable properties; keep this getter outside that native traversal.
Object.defineProperty(cyclic, "unsafe", { get() { getterReads++; throw new Error("getter executed"); } });
Object.defineProperty(cyclic, "toJSON", { value() { getterReads++; } });
Object.defineProperty(cyclic, "toString", { value() { getterReads++; return "wrong"; } });
console.log("object-preview", cyclic, new Error("logged-error-object"));
document.addEventListener("diagnostic-test", function documentFailure() { throw new Error("document-event-failure"); });
setTimeout(() => document.dispatchEvent(new Event("diagnostic-test")), 50);
setTimeout(function timerFailure() { throw new Error("outside-tool-timer-failure"); }, 50);
setTimeout(() => { Promise.reject(new Error("outside-tool-unhandled-rejection")); }, 50);
setTimeout(() => { throw new Error('Permission denied to access property "length"'); }, 50);
setTimeout(() => console.log("outside-tool-timer-log"), 50);
window.selectorAtStartup = $('#selector').textContent;
throw new Error("startup-script-failure");
`;
const HTML = '<!doctype html><html><body><p id="selector">selected</p><script src="/diagnostics.js"></script><script>console.log("after-startup-error")</script></body></html>';

async function eventually(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate() && Date.now() < deadline) await delay(20);
  assert.ok(predicate(), message);
}

test("diagnostic formatting uses one-based protocol locations and bounded data previews", () => {
  const trace = { callFrames: [{ url: "file.js", functionName: "failure", lineNumber: 0, columnNumber: 0 }], parent: {
    callFrames: [{ url: "pagent-agent-mirror", functionName: "internalMirror", lineNumber: 3, columnNumber: 2 }],
  } };
  assert.deepEqual(logLocation(trace), { url: "file.js", line: 1, column: 1,
    stack: "    at failure (file.js:1:1)\n    at internalMirror (pagent-agent-mirror:4:3)" });
  assert.equal(syntheticConsole(trace), true);
  assert.equal(syntheticConsole({ callFrames: [{ url: "pagent-internal" }] }), false);
  assert.equal(syntheticConsole({ callFrames: [{ url: "ordinary.js" }] }), false);
  assert.deepEqual(logLocation(undefined, { url: "syntax.js", lineNumber: 0, columnNumber: 4 }), { url: "syntax.js", line: 1, column: 5 });
  const preview = chromiumConsoleText([{ type: "object", description: "Object", preview: { overflow: true,
    properties: [{ name: "answer", type: "number", value: "42" }, { name: "unsafe", type: "accessor" }] } }]);
  assert.match(preview, /answer: 42/);
  assert.match(preview, /unsafe: accessor/);
  assert.match(preview, /…/);
  assert.ok(chromiumConsoleText([{ type: "object", description: "x".repeat(20_000) }]).length <= 8_000);
  assert.equal(chromiumConsoleText([{ type: "string", value: "x".repeat(20_000) }]).length, 20_000, "agent mirror strings are not truncated");
  assert.match(firefoxConsoleText({ text: "Object(1)", args: [{ type: "object", value: [["answer", { type: "number", value: 42 }]] }] }), /answer: 42/);
});

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine} forwards console and uncaught diagnostics continuously, without tool feedback`, { timeout: 45_000 }, async t => {
    const directory = await mkdtemp(path.join(os.tmpdir(), `pagent-console-${engine}-`));
    const server = createServer((request, response) => {
      response.writeHead(200, { "Content-Type": request.url === "/diagnostics.js" ? "text/javascript" : "text/html", "Cache-Control": "no-store" });
      response.end(request.url === "/diagnostics.js" ? SCRIPT : HTML);
    });
    const logs: BrowserLog[] = [];
    const diagnostics = new DiagnosticBuffer();
    const errors: Error[] = [];
    let browser: PageBrowser | undefined;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    browser = await launchBrowser({
      browser: engine, profileDir: directory, url, headless: true,
      ...(engine === "chromium" ? { noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1" } : {}),
      onRequest: () => {}, onError: error => errors.push(error), onConsole: entry => { logs.push(entry); diagnostics.append(entry); },
    });
    const page = browser;
    const expectedErrors = ["startup-script-failure", "document-event-failure", "outside-tool-timer-failure", "outside-tool-unhandled-rejection", 'Permission denied to access property "length"'];
    for (let load = 0; load < 2; load++) {
      if (load) { logs.length = 0; await page.evaluateValue('globalThis.$ = null'); await page.reload(); }
      // No evaluation or model tool is running while these events arrive.
      await eventually(() => expectedErrors.every(text => logs.some(entry => entry.source === "exception" && entry.text.includes(text)
        && (text === "outside-tool-unhandled-rejection" || entry.url === `${url}diagnostics.js`))), JSON.stringify(logs));
      for (const [text, level, line] of [
        ["startup-log", "info", 1], ["startup-info", "info", 2], ["startup-warn", "warn", 3],
        ["startup-error-level", "error", 4], ["startup-debug", "debug", 5], ["startup-trace", "debug", 6],
      ] as const) {
        const entry = logs.find(entry => entry.text === text);
        assert.ok(entry, `missing ${text}: ${JSON.stringify(logs)}`);
        assert.equal(entry.source, "console");
        assert.equal(entry.level, level);
        assert.equal(entry.url, `${url}diagnostics.js`, JSON.stringify(entry));
        assert.equal(entry.line, line);
        assert.ok(entry.column && entry.column > 0);
        assert.match(entry.stack ?? "", /diagnostics\.js:/);
      }
      for (const text of expectedErrors) {
        const entry = logs.find(entry => entry.source === "exception" && entry.text.includes(text)
          && (text === "outside-tool-unhandled-rejection" || entry.url === `${url}diagnostics.js`));
        assert.ok(entry);
        assert.equal(entry.level, "error");
        // Firefox's BiDi log entry omits stackTrace for unhandled rejections.
        if (engine === "firefox" && text === "outside-tool-unhandled-rejection") continue;
        assert.equal(entry.url, `${url}diagnostics.js`, JSON.stringify(entry));
        assert.ok(entry.line && entry.line > 0);
        assert.ok(entry.column && entry.column > 0);
        assert.match(entry.stack ?? "", /diagnostics\.js:/);
      }
      await eventually(() => logs.some(entry => entry.text === "outside-tool-timer-log"), "timer console output is forwarded without a tool");
      assert.ok(logs.some(entry => entry.text === "after-startup-error"));
      const preview = logs.find(entry => entry.text.startsWith("object-preview"));
      assert.ok(preview, JSON.stringify({ logs, getterReads: await page.evaluateValue("getterReads") }));
      assert.match(preview.text, /answer.*42/);
      assert.match(preview.text, /logged-error-object/);
      assert.ok(preview.text.length < 10_000);
      assert.equal(await page.evaluateValue("getterReads"), 0, "formatting never invokes page getters/toJSON/toString");
      assert.equal(await page.evaluateValue("selectorAtStartup"), "selected", "$ is available before startup scripts on every navigation");
      assert.equal(await page.evaluateValue('(() => { const select = $; return select("#selector") === document.querySelector("#selector"); })()'), true, "$ is bound to document");
      const snapshot = diagnostics.snapshot();
      for (const text of [...expectedErrors, "outside-tool-timer-log"]) {
        assert.ok(snapshot.entries.some(entry => entry.text.includes(text)), `recent context retains ${text} outside evaluations`);
      }
      assert.deepEqual(diagnostics.snapshot(), snapshot, "reading diagnostics never consumes another agent's snapshot");
    }

    await assert.rejects(page.deliver({ seq: 0, event: { type: "saved", revision: "no-receiver" } }), /did not acknowledge/);
    await page.evaluate(`
      window.receiverBroken = false;
      window.received = [];
      aos.addEventListener("event", event => {
        if (receiverBroken) throw new Error("receiver-failure");
        if (!received.some(record => record.seq === event.detail.seq)) {
          received.push(event.detail);
          document.body.dataset.received = JSON.stringify(received);
        }
        event.ack();
      });
      // Diagnostic observers must never acknowledge on behalf of the receiver.
      aos.addEventListener("event", () => console.warn("listener-diagnostic"));
      document.body.dataset.unsaved = "preserve";
      //# sourceURL=page-listener
    `);
    const endpointFile = path.join(directory, engine === "chromium" ? "DevToolsActivePort" : "WebDriverBiDiServer.json");
    const endpoint = await readFile(endpointFile, "utf8");
    const pending = page.evaluate('new Promise(resolve => { window.finishEval = resolve; console.log("tool-log"); })');
    let firstSettled = false;
    void pending.then(() => { firstSettled = true; }, () => { firstSettled = true; });
    await eventually(() => logs.some(entry => entry.text === "tool-log"), "evaluation has started");
    await t.test("queued console cancellation is immediate and leaves the active evaluation untouched", async () => {
      const controller = new AbortController();
      const cancelled = page.evaluate('window.cancelledEvaluationRan = true; document.body.dataset.unsaved = "lost"', { signal: controller.signal });
      controller.abort();
      await assert.rejects(Promise.race([cancelled, delay(500)]), /cancelled before execution/);
      await assert.rejects(Promise.race([
        page.evaluate('window.alreadyAbortedEvaluationRan = true', { signal: controller.signal }), delay(500),
      ]), /cancelled before execution/);
      assert.equal(firstSettled, false, "cancelling the queued job cannot interrupt the active Promise");
      assert.equal(await readFile(endpointFile, "utf8"), endpoint, "the owned browser process was not restarted");
      assert.deepEqual(await page.evaluateValue('[document.body.dataset.unsaved, typeof finishEval, typeof cancelledEvaluationRan, typeof alreadyAbortedEvaluationRan]'),
        ["preserve", "function", "undefined", "undefined"], "internal evaluation stays independent and unsaved DOM/heap survive");
    });
    await page.deliver({ seq: 1, event: { type: "error", message: "mirrored-host-error" } });
    await page.evaluateValue('console.log("internal-diagnostic"); finishEval(9)');
    const result = await pending;
    assert.equal(result.value, 9);
    assert.deepEqual((await page.evaluate('[document.body.dataset.unsaved, typeof cancelledEvaluationRan, typeof alreadyAbortedEvaluationRan, 2 + 3]')).value,
      ["preserve", "undefined", "undefined", 5], "later console jobs work and cancelled jobs never execute after their slot opens");
    assert.deepEqual(result.logs, ["log: tool-log", `${engine === "chromium" ? "warning" : "warn"}: listener-diagnostic`, "log: internal-diagnostic"]);
    const mirror = logs.find(entry => entry.text.includes("mirrored-host-error"));
    assert.ok(mirror?.synthetic, "actual conversation mirroring is explicitly marked but still forwarded");
    assert.equal(mirror.url, "pagent-agent-mirror");
    assert.ok(logs.some(entry => entry.text === "listener-diagnostic" && !entry.synthetic), "dispatch listeners are outside the mirror's source marker");
    assert.ok(logs.some(entry => entry.text === "internal-diagnostic" && !entry.synthetic), "internal evaluation origin does not hide genuine logs");
    const snapshot = diagnostics.snapshot();
    assert.ok(snapshot.entries.some(entry => entry.text === "listener-diagnostic"));
    assert.ok(snapshot.entries.some(entry => entry.text === "internal-diagnostic"));
    assert.ok(!snapshot.entries.some(entry => entry.text.includes("mirrored-host-error")), "diagnostic context never contains conversation mirrors");
    await page.deliver({ seq: 1, event: { type: "error", message: "mirrored-host-error" } });
    assert.equal(logs.filter(entry => entry.text.includes("mirrored-host-error")).length, 1, "same-runtime replay mirrors only once");

    await page.evaluateValue("receiverBroken = true");
    const retry = { seq: 2, event: { type: "error" as const, message: "retry-host-error" } };
    await assert.rejects(page.deliver(retry), /did not acknowledge/);
    assert.equal(await page.evaluateValue("received.length"), 1, "auxiliary diagnostic listener cannot acknowledge failed UI delivery");
    await eventually(() => logs.some(entry => entry.source === "exception" && entry.text.includes("receiver-failure")), "receiver failures remain genuine diagnostics");
    assert.ok(diagnostics.snapshot().entries.some(entry => entry.text.includes("receiver-failure")));
    await page.evaluateValue("receiverBroken = false");
    await page.deliver(retry);
    await page.deliver(retry);
    assert.equal(await page.evaluateValue("received.length"), 2, "repair/retry persists once and acknowledges already-consumed duplicates");
    assert.match(await page.snapshot(), /retry-host-error/);
    assert.equal(logs.filter(entry => entry.text.includes("retry-host-error")).length, 1, "failed delivery retry does not mirror twice");
    assert.ok(!diagnostics.snapshot().entries.some(entry => entry.text.includes("retry-host-error")), "retry mirroring never feeds back into model context");

    const bounded = await page.evaluate('for (let i = 0; i < 220; i++) console.log("bounded", i); console.log("x".repeat(20_000));');
    assert.equal(bounded.logs.length, 200);
    assert.ok(bounded.logs.every(line => line.length <= 8_000));
    assert.ok(logs.some(entry => entry.text === "bounded 219"), "the tool cap never suppresses stdout forwarding");
    assert.ok(logs.some(entry => entry.text === "x".repeat(20_000)), "large mirror/plain strings reach stdout intact");
    const long = await page.evaluate('console.log("x".repeat(20_000))');
    assert.equal(long.logs[0]?.length, 8_000, "per-tool entries retain their size limit");
    assert.deepEqual((await page.evaluate("1")).logs, [], "tool log collection does not persist between calls");
    assert.deepEqual(errors, [], "page errors are diagnostics, not browser transport failures");
  });
}
