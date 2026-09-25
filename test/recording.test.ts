import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Script } from "node:vm";
import { DomRecorder, RECORDING_VIEWER, type RecordingClock } from "../src/recording.ts";
import type { HostEvent } from "../src/protocol.ts";

class Clock implements RecordingClock {
  time = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  private id = 0;
  now(): number { return this.time; }
  wallTime(): string { return new Date(1_700_000_000_000 + this.time).toISOString(); }
  schedule(callback: () => void, delayMs: number): () => void {
    const id = this.id++;
    this.timers.set(id, { at: this.time + delayMs, callback });
    return () => { this.timers.delete(id); };
  }
  advance(ms: number): void {
    // Deliberately run overdue callbacks at the new time, like a delayed event loop.
    this.time += ms;
    for (;;) {
      const next = [...this.timers].find(([, timer]) => timer.at <= this.time);
      if (!next) return;
      this.timers.delete(next[0]);
      next[1].callback();
    }
  }
}

interface RecordLine {
  type: string;
  phase?: string;
  count?: number;
  intendedMs?: number;
  actualMs: number;
  at: string;
  html?: string;
  screenshot?: string;
  reason?: string;
  message?: string;
  events?: { kind: string; seq: number; agentId?: string; callId?: string; contentIndex?: number; deliveredMs: number }[];
  omittedEvents?: number;
}

async function records(directory: string): Promise<RecordLine[]> {
  return (await readFile(path.join(directory, "manifest.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line) as RecordLine);
}

async function eventually(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5); }
  throw new Error("Timed out waiting for recorder I/O.");
}

const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lVQAAAAASUVORK5CYII=";
const frame = { html: '<!doctype html><p-agent><template shadowrootmode="open" shadowrootserializable><p>history</p></template></p-agent>', screenshot: png };

test("records private baseline, frames, final frame, PNG and inert local viewer", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-"));
  const clock = new Clock();
  const requests: boolean[] = [];
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 500, screenshots: true, clock,
    browser: { async captureFrame(options) { requests.push(options.screenshot); return frame; } } });
  try {
    await recorder.start();
    await recorder.start();
    assert.equal(requests.length, 1);
    clock.advance(500);
    await eventually(async () => (await records(recorder.directory)).filter(record => record.type === "frame").length === 2);
    await recorder.stop();
    await recorder.stop();
    const log = await records(recorder.directory);
    assert.deepEqual(log.filter(record => record.type === "frame").map(record => record.phase), ["baseline", "sample", "final"]);
    assert.deepEqual(log.filter(record => record.type === "frame").map(record => record.intendedMs), [0, 500, 500]);
    assert.equal(log[0].type, "start");
    assert.equal(log.at(-1)?.type, "stop");
    for (const entry of log) { assert.ok(Number.isFinite(entry.actualMs)); assert.ok(Number.isFinite(Date.parse(entry.at))); }
    const first = log.find(record => record.type === "frame")!;
    assert.equal(await readFile(path.join(recorder.directory, first.html!), "utf8"), frame.html);
    assert.deepEqual(await readFile(path.join(recorder.directory, first.screenshot!)), Buffer.from(png, "base64"));
    assert.deepEqual(requests, [true, true, true]);
    assert.equal(await readFile(path.join(recorder.directory, "viewer.html"), "utf8"), RECORDING_VIEWER);
    assert.match(RECORDING_VIEWER, /webkitdirectory/);
    assert.match(RECORDING_VIEWER, /connect-src 'none'/);
    assert.doesNotMatch(RECORDING_VIEWER, /innerHTML|srcdoc|<iframe|fetch\(/);
    assert.ok(RECORDING_VIEWER.includes(".split('\\n')"));
    new Script(RECORDING_VIEWER.match(/<script>([\s\S]*?)<\/script>/)![1]);
    assert.equal(clock.timers.size, 0);
    assert.deepEqual(await readdir(directory), ["recordings"]);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("one in-flight capture skips overdue intervals without a catch-up queue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-"));
  const clock = new Clock();
  let calls = 0;
  let release!: (value: { html: string }) => void;
  const pending = new Promise<{ html: string }>(resolve => { release = resolve; });
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 500, clock,
    browser: { captureFrame: async () => ++calls === 2 ? pending : frame } });
  try {
    await recorder.start();
    clock.advance(500);
    assert.equal(calls, 2);
    clock.advance(1_500);
    assert.equal(calls, 2);
    await eventually(async () => (await records(recorder.directory)).filter(record => record.type === "skip").length === 2);
    const skips = (await records(recorder.directory)).filter(record => record.type === "skip");
    assert.deepEqual(skips.map(record => [record.reason, record.count]), [["timer delayed", 2], ["capture in flight", 1]]);
    release(frame);
    await eventually(async () => (await records(recorder.directory)).filter(record => record.type === "frame").length === 2);
    clock.advance(500);
    await eventually(async () => (await records(recorder.directory)).filter(record => record.type === "frame").length === 3);
    await recorder.stop();
    assert.equal(calls, 4);
    assert.equal(clock.timers.size, 0);
  } finally { release(frame); await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("capture errors are archived and subsequent samples continue", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-"));
  const clock = new Clock();
  let calls = 0;
  const messages: string[] = [];
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 500, clock, log: text => messages.push(text),
    browser: { async captureFrame() { if (++calls === 1) throw new Error("Renderer unavailable"); return { html: "<p>recovered</p>" }; } } });
  try {
    await recorder.start();
    clock.advance(500);
    await eventually(async () => (await records(recorder.directory)).some(record => record.type === "frame"));
    await recorder.stop();
    const log = await records(recorder.directory);
    assert.match(log.find(record => record.type === "error")!.message!, /Renderer unavailable/);
    assert.ok(log.some(record => record.phase === "sample" && !record.screenshot));
    assert.match(messages.join("\n"), /Renderer unavailable/);
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("stop is bounded when a capture hangs, and late rejection is handled", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-"));
  const clock = new Clock();
  let calls = 0;
  let reject!: (error: Error) => void;
  const hung = new Promise<never>((_resolve, failure) => { reject = failure; });
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 500, clock,
    browser: { async captureFrame() { return ++calls === 1 ? frame : hung; } } });
  try {
    await recorder.start();
    clock.advance(500);
    const stopped = recorder.stop();
    await Promise.resolve();
    clock.advance(2_000);
    await stopped;
    assert.equal(calls, 2);
    assert.equal(clock.timers.size, 0);
    const before = await records(recorder.directory);
    assert.ok(before.some(record => record.type === "error" && /final frame omitted/.test(record.message ?? "")));
    assert.equal(before.at(-1)?.type, "stop");
    reject(new Error("late renderer rejection"));
    await delay(10);
    assert.deepEqual(await records(recorder.directory), before);
  } finally { reject(new Error("test cleanup")); await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("hung baseline has a bounded startup and stopped captures cannot publish late frames", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-"));
  const clock = new Clock();
  let release!: (value: typeof frame) => void;
  const hung = new Promise<typeof frame>(resolve => { release = resolve; });
  let calls = 0;
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 500, clock,
    browser: { async captureFrame() { calls++; return hung; } } });
  try {
    const started = recorder.start();
    await eventually(async () => calls === 1);
    clock.advance(2_000);
    await started;
    const stopped = recorder.stop();
    await Promise.resolve();
    clock.advance(2_000);
    await stopped;
    release(frame);
    await delay(10);
    const log = await records(recorder.directory);
    assert.ok(log.some(record => record.type === "error" && record.phase === "baseline"));
    assert.equal(log.filter(record => record.type === "frame").length, 0);
    assert.deepEqual(await readdir(path.join(recorder.directory, "frames")), []);
    assert.equal(clock.timers.size, 0);
  } finally { release(frame); await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("stop cancels periodic sampling immediately while the baseline is still pending", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-"));
  const clock = new Clock();
  const baseline = Promise.withResolvers<typeof frame>();
  let calls = 0;
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 500, clock,
    browser: { async captureFrame() { return ++calls === 1 ? baseline.promise : frame; } } });
  try {
    const starting = recorder.start();
    await eventually(async () => calls === 1);
    const stopped = recorder.stop();
    clock.advance(500);
    baseline.resolve(frame);
    await starting;
    await stopped;
    const log = await records(recorder.directory);
    assert.deepEqual(log.filter(record => record.type === "frame").map(record => record.phase), ["baseline", "final"]);
    assert.equal(log.some(record => record.type === "skip"), false);
    assert.equal(clock.timers.size, 0);
  } finally { baseline.resolve(frame); await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("validates interval, requires capture support, and permits stop before start", async () => {
  for (const intervalMs of [0, -1, 0.5, NaN, Infinity, 2_147_483_648]) {
    assert.throws(() => new DomRecorder({ stateDirectory: tmpdir(), intervalMs, browser: {} }), /intervalMs/);
  }
  const recorder = new DomRecorder({ stateDirectory: tmpdir(), intervalMs: 500, browser: {} });
  await assert.rejects(recorder.start(), /does not support/);
  await recorder.stop();
  const unopened = new DomRecorder({ stateDirectory: tmpdir(), intervalMs: 500, browser: {} });
  await unopened.stop();
  await assert.rejects(unopened.start(), /cannot be restarted/);
});

const completion = (seq: number): HostEvent => ({ seq, agentId: "one", requestId: "input", runId: "run",
  event: { type: "tool", phase: "end", name: "console", callId: `call-${seq}`, result: { huge: "not retained" } } });

test("completion bursts are bounded, attributed, nonblocking and coalesced behind one capture", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-events-"));
  const clock = new Clock();
  const slow = Promise.withResolvers<typeof frame>();
  let calls = 0;
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 30_000, events: ["tool", "thinking", "message"], clock,
    browser: { async captureFrame() { return ++calls === 2 ? slow.promise : frame; } } });
  try {
    recorder.observe(completion(0)); // Not armed until baseline starts.
    await recorder.start();
    recorder.observe({ seq: 1, agentId: "one", event: { type: "message", phase: "update", thinkingEnd: 0, message: { role: "assistant" } } });
    recorder.observe({ seq: 2, agentId: "two", event: { type: "message", phase: "end", message: { role: "assistant" } } });
    for (let seq = 3; seq <= 100; seq++) assert.equal(recorder.observe(completion(seq)), undefined);
    clock.advance(999);
    assert.equal(calls, 1);
    clock.advance(1);
    assert.equal(calls, 2);
    for (let seq = 101; seq <= 200; seq++) recorder.observe(completion(seq));
    clock.advance(5_000);
    assert.equal(calls, 2, "no overlapping capture or model-facing wait");
    slow.resolve(frame);
    await eventually(async () => (await records(recorder.directory)).filter(record => record.phase === "event").length === 1);
    clock.advance(999);
    assert.equal(calls, 2, "always leave breathing room after the prior capture settles");
    clock.advance(1);
    await eventually(async () => (await records(recorder.directory)).filter(record => record.phase === "event").length === 2);
    const frames = (await records(recorder.directory)).filter(record => record.phase === "event");
    assert.deepEqual(frames.map(record => [record.events?.length, record.omittedEvents]), [[32, 68], [32, 68]]);
    assert.deepEqual(frames[0].events?.slice(0, 3).map(event => [event.kind, event.agentId, event.seq]),
      [["thinking", "one", 1], ["message", "two", 2], ["tool", "one", 3]]);
    assert.equal(frames[0].events?.[0].contentIndex, 0);
    assert.equal(frames[0].events?.[2].callId, "call-3");
    assert.doesNotMatch(JSON.stringify(frames), /not retained/);
    recorder.observe(completion(201));
    recorder.disableEvents();
    clock.advance(1_000);
    recorder.observe(completion(202));
    assert.equal(calls, 3);
    await recorder.stop();
    const all = await records(recorder.directory);
    assert.equal(all.filter(record => record.phase === "final").length, 1);
    assert.ok(all.some(record => record.type === "skip" && record.reason === "completion triggers disabled" && record.count === 1));
    clock.advance(60_000);
    recorder.observe(completion(203));
    assert.equal(calls, 4);
    assert.equal(clock.timers.size, 0);
  } finally { slow.resolve(frame); await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("periodic frames absorb pending completions and do not leave a redundant capture queued", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-events-"));
  const clock = new Clock();
  let calls = 0;
  const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 30_000, events: ["tool"], clock,
    browser: { async captureFrame() { calls++; return frame; } } });
  try {
    await recorder.start();
    clock.advance(29_500);
    recorder.observe({ ...completion(1), agentId: "a".repeat(400), event: { type: "tool", phase: "end", name: "console", callId: "c".repeat(400) } });
    clock.advance(500);
    await eventually(async () => (await records(recorder.directory)).some(record => record.phase === "sample"));
    clock.advance(1_000);
    assert.equal(calls, 2);
    const sample = (await records(recorder.directory)).find(record => record.phase === "sample")!;
    assert.equal(sample.events?.[0].agentId?.length, 200);
    assert.equal(sample.events?.[0].callId?.length, 200);
    assert.equal(sample.events?.[0].deliveredMs, 29_500);
    recorder.observe(completion(2));
    await recorder.stop();
    clock.advance(10_000);
    assert.equal(calls, 3, "stop cancels the pending event timer but retains final capture");
  } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
});

test("completion triggers are opt-in and never react to starts, deltas, users or tool-result messages", async () => {
  for (const events of [undefined, [], ["tool"]] as const) {
    const directory = await mkdtemp(path.join(tmpdir(), "pagent-recording-events-"));
    const clock = new Clock();
    let calls = 0;
    const recorder = new DomRecorder({ stateDirectory: directory, intervalMs: 30_000, events: events ? [...events] : undefined, clock,
      browser: { async captureFrame() { calls++; return frame; } } });
    try {
      await recorder.start();
      if (!events?.length) recorder.observe(completion(1));
      for (const phase of ["start", "update", "end"] as const) {
        for (const role of ["user", "toolResult"]) recorder.observe({ seq: 2, event: { type: "message", phase, message: { role } } });
      }
      for (const phase of ["start", "update"] as const) {
        recorder.observe({ seq: 3, event: { type: "tool", phase, name: "console", callId: "call" } });
        recorder.observe({ seq: 4, event: { type: "message", phase, message: { role: "assistant" } } });
      }
      recorder.observe({ seq: 5, event: { type: "message", phase: "update", thinkingEnd: 0, message: { role: "assistant" } } });
      recorder.observe({ seq: 6, event: { type: "message", phase: "end", message: { role: "assistant" } } });
      clock.advance(2_000);
      assert.equal(calls, 1);
      await recorder.stop();
      assert.deepEqual((await records(recorder.directory)).filter(record => record.type === "frame").map(record => record.phase), ["baseline", "final"]);
    } finally { await recorder.stop(); await rm(directory, { recursive: true, force: true }); }
  }
});
