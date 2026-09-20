import assert from "node:assert/strict";
import test from "node:test";
import { DiagnosticBuffer } from "../src/diagnostics.ts";
import type { BrowserLog } from "../src/protocol.ts";

const log = (text: string): BrowserLog => ({ source: "console", level: "info", text });

test("diagnostics retain recent entries with sequence/time, without consuming or sharing mutable snapshots", () => {
  const buffer = new DiagnosticBuffer({ maxEntries: 2 });
  const before = Date.now();
  buffer.append(log("first"));
  buffer.append({ ...log("mirror"), synthetic: true });
  const original = { ...log("second"), url: "http://workspace/app.js", line: 3, column: 7, stack: "at app.js:3:7" };
  buffer.append(original);
  original.text = "changed";
  const snapshot = buffer.snapshot();
  assert.deepEqual(snapshot.entries.map(entry => [entry.seq, entry.text]), [[1, "first"], [2, "second"]]);
  assert.ok(snapshot.entries.every(entry => entry.time >= before && entry.time <= Date.now()));
  assert.equal(snapshot.entries[1].line, 3);
  assert.equal(snapshot.entries[1].stack, "at app.js:3:7");
  assert.equal(snapshot.dropped, 0);
  assert.equal(snapshot.truncated, 0);
  assert.deepEqual(buffer.snapshot(), snapshot);
  snapshot.entries[0].text = "mutated copy";
  assert.equal(buffer.snapshot().entries[0].text, "first");
  buffer.append({ source: "exception", level: "error", text: "third" });
  assert.deepEqual(buffer.snapshot().entries.map(entry => entry.text), ["second", "third"]);
  assert.equal(buffer.snapshot().dropped, 1);
});

test("diagnostics bound serialized UTF-8 entry and snapshot bytes, reporting truncation and eviction", () => {
  const buffer = new DiagnosticBuffer({ maxEntries: 200, maxBytes: 1024, maxEntryBytes: 512 });
  for (let index = 0; index < 20; index++) {
    buffer.append({ ...log(`${index}:` + "🎉\n\u0000\\\"".repeat(500)), stack: "λ\n".repeat(500), url: "https://example.com/" + "界".repeat(500) });
    const snapshot = buffer.snapshot();
    assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 1024);
    assert.ok(snapshot.entries.length > 0, "newest entry always fits");
    assert.equal(snapshot.entries.at(-1)?.seq, index + 1);
    assert.equal(snapshot.truncated, index + 1);
    for (const entry of snapshot.entries) {
      assert.ok(entry.truncated);
      assert.ok(Buffer.byteLength(JSON.stringify(entry)) <= 512);
      for (const text of [entry.text, entry.stack, entry.url]) {
        assert.equal(Buffer.from(text ?? "", "utf8").toString("utf8"), text, "truncation does not split surrogate pairs");
        assert.ok(!text?.includes("�"));
      }
    }
  }
  assert.ok(buffer.snapshot().dropped > 0);
});

test("default diagnostics snapshot stays within 32 KiB and 200 entries under floods", () => {
  const buffer = new DiagnosticBuffer();
  for (let index = 0; index < 500; index++) buffer.append(log(`${index}:` + "z".repeat(index % 2 ? 40_000 : 20)));
  const snapshot = buffer.snapshot();
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= 32 * 1024);
  assert.ok(snapshot.entries.length <= 200);
  assert.equal(snapshot.entries.at(-1)?.seq, 500);
  assert.ok(snapshot.entries.every(entry => Buffer.byteLength(JSON.stringify(entry)) <= 8 * 1024));
  assert.ok(snapshot.dropped > 0);
  assert.equal(snapshot.truncated, 250);
});

test("diagnostic limits reject configurations that cannot hold an entry and snapshot envelope", () => {
  for (const limits of [{ maxEntries: 0 }, { maxEntries: 1.5 }, { maxBytes: 511 }, { maxEntryBytes: 255 }, { maxBytes: 512, maxEntryBytes: 512 }]) {
    assert.throws(() => new DiagnosticBuffer(limits), /Diagnostic limits/);
  }
});
