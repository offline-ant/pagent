import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { EventJournal } from "../src/journal.ts";

test("outbox coalesces partial streams, replays completed IO, and retires only checkpointed records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-journal-"));
  try {
    const journal = new EventJournal(directory);
    journal.observeCursor(50);
    const scope = { agentId: "main", requestId: "p0", runId: "run-0" };
    const running = journal.append({ type: "status", status: "running" }, scope);
    journal.append({ type: "message", phase: "update", message: { content: "first partial" } }, scope);
    const latest = journal.append({ type: "message", phase: "update", message: { content: "latest partial" } }, scope);
    assert.deepEqual(journal.after(50).map(record => record.seq), [running.seq, latest.seq]);
    assert.doesNotMatch(await readFile(path.join(directory, "outbox.jsonl"), "utf8"), /partial/);
    const complete = journal.append({ type: "message", phase: "end", message: { content: "completed" } }, scope);
    assert.deepEqual(journal.after(50).map(record => record.seq), [running.seq, complete.seq]);
    journal.checkpoint(running.seq);
    assert.deepEqual(new EventJournal(directory).after(0), [complete]);
    journal.checkpoint(complete.seq);
    const restarted = new EventJournal(directory);
    assert.deepEqual(restarted.after(0), []);
    restarted.observeCursor(complete.seq);
    assert(restarted.append({ type: "connected", url: "http://127.0.0.1:8080/", model: "fake", busy: false }).seq > complete.seq);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("partial coalescing isolates agent, run, request and tool identities", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-journal-scope-"));
  try {
    const journal = new EventJournal(directory);
    const scopes = [
      { agentId: "main", requestId: "p0", runId: "run-0" },
      { agentId: "other", requestId: "p0", runId: "run-0" },
      { agentId: "main", requestId: "p0", runId: "run-1" },
      { agentId: "main", requestId: "p1", runId: "run-0" },
    ];
    const partials = scopes.map(scope => journal.append({ type: "message", phase: "update", message: { content: "partial" } }, scope));
    const tool = journal.append({ type: "tool", phase: "update", callId: "tool-0", name: "console", result: "partial" }, scopes[0]);
    const otherTool = journal.append({ type: "tool", phase: "update", callId: "tool-1", name: "console", result: "partial" }, scopes[0]);
    const latest = journal.append({ type: "message", phase: "update", message: { content: "latest" } }, scopes[0]);
    assert.deepEqual(journal.after(0), [...partials.slice(1), tool, otherTool, latest]);
    const complete = journal.append({ type: "message", phase: "end", message: { content: "complete" } }, scopes[0]);
    assert.deepEqual(journal.after(0), [...partials.slice(1), tool, otherTool, complete]);
    assert.deepEqual(new EventJournal(directory).after(0), [complete], "only completed records survive restart with their full scope");
    journal.checkpoint(tool.seq);
    assert.deepEqual(journal.after(0), [otherTool, complete], "checkpointing retires only covered partials");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ephemeral delivery never reads or changes the durable outbox and discards old page events", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-journal-memory-"));
  try {
    const filename = path.join(directory, "outbox.jsonl");
    await writeFile(filename, "older durable evidence\n");
    const journal = new EventJournal();
    assert.deepEqual(journal.after(0), []);
    const record = journal.append({ type: "status", status: "running" });
    assert.deepEqual(journal.after(0), [record]);
    journal.discard();
    assert.deepEqual(journal.after(0), []);
    const next = journal.append({ type: "status", status: "idle" });
    assert.ok(next.seq > record.seq, "discarding a runtime does not reuse sequence IDs");
    journal.checkpoint(next.seq);
    assert.deepEqual(journal.after(0), []);
    assert.equal(await readFile(filename, "utf8"), "older durable evidence\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("outbox recovers only an incomplete final append and rejects damaged complete records", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-journal-"));
  const filename = path.join(directory, "outbox.jsonl");
  try {
    const journal = new EventJournal(directory);
    const record = journal.append({ type: "status", status: "idle" });
    await appendFile(filename, '{"seq":');
    assert.deepEqual(new EventJournal(directory).after(0), [record]);
    assert.equal(await readFile(filename, "utf8"), JSON.stringify(record) + "\n");
    await writeFile(filename, "broken\n");
    assert.throws(() => new EventJournal(directory));
    assert.equal(await readFile(filename, "utf8"), "broken\n");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
