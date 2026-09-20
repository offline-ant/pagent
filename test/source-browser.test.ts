import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPagent, type PagentApp } from "../src/app.ts";

const sources = [
  { resource: "/data/iris.csv", url: "https://raw.githubusercontent.com/plotly/datasets/master/iris.csv" },
  { resource: "/vendor/d3-dsv.js", url: "https://cdn.jsdelivr.net/npm/d3-dsv@3.0.1/+esm" },
];
const columns = ["SepalLength", "SepalWidth", "PetalLength", "PetalWidth", "Name"];

// This is browser source, never imported/evaluated by Node. The downloaded
// library remains byte-for-byte unchanged; only this small bootstrap is authored.
const bootstrap = `import { csvParse } from '/vendor/d3-dsv.js';
if (typeof process !== 'undefined') throw new Error('CSV demo must not run in Node');
if (window !== globalThis || !document.body) throw new Error('CSV demo requires a browser document');
const response = await fetch('/data/iris.csv');
if (!response.ok) throw new Error('CSV read failed: ' + response.status);
const rows = csvParse(await response.text());
const table = document.createElement('table');
table.id = 'csv-demo';
const header = table.createTHead().insertRow();
for (const column of rows.columns) {
  const cell = document.createElement('th');
  cell.textContent = column;
  header.append(cell);
}
const body = table.createTBody();
for (const row of rows) {
  const tr = body.insertRow();
  for (const column of rows.columns) tr.insertCell().textContent = row[column];
}
document.querySelector('#csv-demo')?.remove();
document.body.append(table);
window.pagentCsvDemo = { runtime: crypto.randomUUID(), rows: rows.length, processType: typeof process };
`;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function waitForTable(app: PagentApp): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await app.browser.evaluateValue("document.querySelector('#csv-demo tbody')?.rows.length === 150")) return;
    await delay(25);
  }
  assert.fail("Browser bootstrap did not recreate the 150-row CSV table");
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser}: real Source CSV + pinned browser ESM survive save/reload`, {
    skip: process.env.PAGENT_LIVE_SOURCE !== "1"
      ? "Live GitHub/jsDelivr network smoke is opt-in; set PAGENT_LIVE_SOURCE=1 (no paid provider calls)."
      : false,
    timeout: 120_000,
  }, async t => {
    const root = await mkdtemp(path.join(tmpdir(), "pagent-source-browser-"));
    const logs: string[] = [];
    let app: PagentApp | undefined;
    try {
      assert.equal(Object.hasOwn(globalThis, "pagentCsvDemo"), false);
      app = await startPagent({ directory: root, browser,
        headless: true, fake: true, port: 0,
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1",
        log: line => logs.push(line) });

      const hashes = new Map<string, string>();
      for (const source of sources) {
        // Independent reference fetch reads bytes only, never imports downloaded JS.
        const reference = await fetch(source.url, {
          headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(25_000),
        });
        assert.equal(reference.status, 200, `Reference GET ${source.url}`);
        const bytes = Buffer.from(await reference.arrayBuffer());
        if (source.resource.endsWith(".js")) {
          // This pinned artifact is a self-contained bundle, not an ESM wrapper
          // whose imports would resolve against missing local npm/CDN paths.
          const text = bytes.toString("utf8");
          assert.match(text, /export\s*\{/);
          assert.doesNotMatch(text, /\bimport\b|\bfrom\s*["']|\brequire\s*\(/);
        }
        const result = await app.browser.evaluate(`(async () => {
          const response = await fetch(${JSON.stringify(source.resource)}, {
            method: 'PUT', headers: { Source: ${JSON.stringify(source.url)} }
          });
          return { status: response.status, body: await response.text() };
        })()`);
        assert.equal(result.error, undefined);
        assert.deepEqual(result.value, { status: 204, body: "" }, `Empty-body Source PUT ${source.url}`);
        const stored: Buffer = await readFile(path.join(app.directory, source.resource.slice(1)));
        assert.deepEqual(stored, bytes, "Source copies exact bytes, without model rewriting");
        hashes.set(source.resource, sha256(bytes));
        t.diagnostic(`${source.url} -> ${source.resource}: ${stored.length} bytes; sha256 ${sha256(stored)}`);
      }

      assert.deepEqual(await app.browser.evaluateValue(`(async () => {
        const response = await fetch('/?list');
        if (!response.ok) throw new Error('Listing failed: ' + response.status);
        return (await response.json()).filter(entry => ['data', 'vendor'].includes(entry.name));
      })()`), [{ name: "data", type: "directory" }, { name: "vendor", type: "directory" }]);
      assert.deepEqual(await app.browser.evaluateValue(`(async () => {
        const response = await fetch('/data/');
        if (!response.ok) throw new Error('Listing failed: ' + response.status);
        return (await response.json()).map(entry => ({ name: entry.name, type: entry.type }));
      })()`), [{ name: "iris.csv", type: "file" }]);

      // All library execution/CSV parsing occurs in this browser console expression.
      const parsed = await app.browser.evaluate(`(async () => {
        window.pagentCsvScratch = await import('/vendor/d3-dsv.js');
        const response = await fetch('/data/iris.csv');
        if (!response.ok) throw new Error('CSV read failed: ' + response.status);
        const rows = window.pagentCsvScratch.csvParse(await response.text());
        return { count: rows.length, columns: rows.columns, first: rows[0], last: rows.at(-1),
          processType: typeof process, browser: window === globalThis && !!document.body };
      })()`);
      assert.equal(parsed.error, undefined);
      assert.deepEqual(parsed.value, {
        count: 150, columns,
        first: { SepalLength: "5.1", SepalWidth: "3.5", PetalLength: "1.4", PetalWidth: "0.2", Name: "Iris-setosa" },
        last: { SepalLength: "5.9", SepalWidth: "3.0", PetalLength: "5.1", PetalWidth: "1.8", Name: "Iris-virginica" },
        processType: "undefined", browser: true,
      });
      await app.browser.reload();
      assert.equal(await app.browser.evaluateValue("typeof window.pagentCsvScratch"), "undefined",
        "A console import is runtime scratch state, not a saved script");

      const installed = await app.browser.evaluate(`(async () => {
        const response = await fetch('/csv-demo.js', { method: 'PUT',
          headers: { 'Content-Type': 'text/javascript' }, body: ${JSON.stringify(bootstrap)} });
        if (!response.ok) throw new Error('Bootstrap write failed: ' + response.status);
        const script = document.createElement('script');
        script.type = 'module';
        script.src = '/csv-demo.js';
        document.body.append(script);
        return response.status;
      })()`);
      assert.equal(installed.error, undefined);
      assert.equal(installed.value, 204);
      assert.equal(await readFile(path.join(app.directory, "csv-demo.js"), "utf8"), bootstrap);
      await waitForTable(app);
      const initialRuntime = await app.browser.evaluateValue("window.pagentCsvDemo.runtime");
      assert.equal(typeof initialRuntime, "string");
      // Deliberately exclude the rendered table from the checkpoint: a surviving
      // DOM snapshot cannot produce a false-positive for bootstrap re-execution.
      await app.browser.evaluateValue("document.querySelector('#csv-demo').remove()");
      await app.save();
      await app.flush();
      const saved = await readFile(path.join(app.directory, "index.html"), "utf8");
      assert.match(saved, /<script type="module" src="\/csv-demo\.js"><\/script>/);
      assert.doesNotMatch(saved, /<table\b[^>]*id="csv-demo"/);
      await app.browser.reload();
      await waitForTable(app);
      assert.notEqual(await app.browser.evaluateValue("window.pagentCsvDemo.runtime"), initialRuntime);
      assert.deepEqual(await app.browser.evaluateValue(`(() => ({
        tables: document.querySelectorAll('#csv-demo').length,
        rows: document.querySelector('#csv-demo tbody').rows.length,
        columns: [...document.querySelectorAll('#csv-demo th')].map(cell => cell.textContent),
        last: [...document.querySelector('#csv-demo tbody').rows].at(-1).lastElementChild.textContent,
        scripts: document.querySelectorAll('script[type="module"][src="/csv-demo.js"]').length,
        processType: window.pagentCsvDemo.processType,
        scratch: typeof window.pagentCsvScratch,
        externalResources: performance.getEntriesByType('resource').filter(entry => new URL(entry.name).origin !== location.origin).map(entry => entry.name)
      }))()`), { tables: 1, rows: 150, columns, last: "Iris-virginica", scripts: 1,
        processType: "undefined", scratch: "undefined", externalResources: [] });
      assert.equal(Object.hasOwn(globalThis, "pagentCsvDemo"), false, "Browser sentinel never appears in the host");
      for (const source of sources) {
        assert.equal(sha256(await readFile(path.join(app.directory, source.resource.slice(1)))), hashes.get(source.resource));
      }
      assert.deepEqual(logs, [], `Unexpected host errors: ${logs.join("\n")}`);
      t.diagnostic("150 Iris rows parsed in browser; temporary import lost on reload; saved static-import bootstrap recreated table; no external browser dependencies or host JS execution.");
    } finally {
      try { await app?.close(); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
}
