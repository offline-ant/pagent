import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { Execution } from "../src/execution.ts";
import type { AgentRun } from "../src/protocol.ts";

const complete = (agentId: string, status: AgentRun["status"] = "complete"): AgentRun => ({ id: `run-${agentId}`, agentId, inputId: "input", status, result: "done" });

test("explicit kickoff concurrently nudges configured participants and repeats only completed continuous agents", async () => {
  const calls: string[] = [];
  let starts = 0;
  let stops = 0;
  let flushed = 0;
  const execution = new Execution({
    repeatDelayMs: 5,
    participants: () => [
      { id: "a", configuration: { mode: "continuous", repeatPromptSource: { kind: "raw", value: "do something" } } },
      { id: "b", configuration: { repeatPromptSource: { kind: "raw", value: "once" } } },
      { id: "c", configuration: {} },
    ],
    prompt: async id => { calls.push(id); }, flush: async () => { flushed++; }, cancel: async () => {},
    changed: () => {}, onStart: async () => { starts++; }, onStop: async () => { stops++; }, log: () => {},
  });
  assert.equal(execution.state, "armed");
  assert.equal(execution.blocked, false);
  await execution.start();
  assert.deepEqual(calls, ["a", "b"]);
  execution.completed(complete("a"));
  execution.completed(complete("b"));
  await delay(30);
  assert.equal(flushed, 1);
  assert.deepEqual(calls, ["a", "b", "a"]);
  execution.completed(complete("a", "error"));
  execution.completed(complete("a", "cancelled"));
  await delay(20);
  assert.equal(calls.length, 3);
  await execution.start();
  assert.equal(starts, 1);
  assert.equal(calls.length, 5);
  await execution.stop();
  await execution.stop();
  assert.equal(stops, 1);
  assert.equal(execution.blocked, true);
  await assert.rejects(execution.start(), /stopped/);
});

test("deadline begins once and gates work before cancellation settles", async () => {
  let cancelled = false;
  let finish!: () => void;
  const execution = new Execution({ durationMs: 40, participants: () => [], prompt: async () => {}, flush: async () => {},
    cancel: async () => { cancelled = true; await new Promise<void>(resolve => { finish = resolve; }); }, changed: () => {}, log: () => {} });
  assert.equal(execution.blocked, true);
  await execution.start();
  assert.equal(execution.blocked, false);
  await delay(20);
  await execution.start();
  await delay(40);
  assert.equal(execution.state, "stopped");
  assert.equal(execution.blocked, true);
  assert.equal(cancelled, true);
  finish();
  await execution.stop();
});

test("pause and disposal invalidate pending delivery waits, not just existing timers", async () => {
  let release!: () => void;
  let calls = 0;
  const execution = new Execution({ repeatDelayMs: 0,
    participants: () => [{ id: "a", configuration: { mode: "continuous", repeatPromptSource: { kind: "raw", value: "again" } } }],
    prompt: async () => { calls++; }, flush: () => new Promise<void>(resolve => { release = resolve; }),
    cancel: async () => {}, changed: () => {}, log: () => {},
  });
  await execution.start();
  execution.completed(complete("a"));
  execution.pause("a");
  release();
  await delay(20);
  assert.equal(calls, 1);
  execution.completed(complete("a"));
  execution.remove("a");
  release();
  await delay(20);
  await execution.nudge();
  assert.equal(calls, 1);
  await execution.stop();
});

test("terminal stop captures before cancellation and starts its hook without waiting for a stalled cancel", async () => {
  const captured = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const order: string[] = [];
  const execution = new Execution({ participants: () => [], prompt: async () => {}, flush: async () => {},
    changed: () => {}, log: () => {},
    onStop: async () => { order.push("capture"); await captured.promise; },
    cancel: async () => { order.push("cancel"); await cancelled.promise; },
  });
  const stopping = execution.stop();
  assert.equal(execution.state, "stopped");
  assert.deepEqual(order, ["capture"]);
  captured.resolve();
  await delay(0);
  assert.deepEqual(order, ["capture", "cancel"]);
  cancelled.resolve();
  await stopping;
});

test("pause invalidates a prompt already waiting to dispatch and stale browser submissions", async () => {
  const waiting = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let calls = 0;
  let scheduleId = "";
  const execution = new Execution({
    participants: () => [{ id: "a", configuration: { mode: "continuous", repeatPromptSource: { kind: "raw", value: "again" } } }],
    prompt: async (_id, token, current) => {
      scheduleId = token;
      waiting.resolve();
      await release.promise;
      if (current()) calls++;
    }, flush: async () => {}, cancel: async () => {}, changed: () => {}, log: () => {},
  });
  const started = execution.start();
  await waiting.promise;
  execution.pause("a");
  release.resolve();
  await started;
  assert.equal(calls, 0);
  assert.equal(execution.accept("a", scheduleId), false);
  await execution.nudge();
  assert.equal(calls, 1);
  assert.equal(execution.accept("a", scheduleId), true);
  assert.equal(execution.accept("a", scheduleId), false, "a scheduled submission is admitted once");
  await execution.stop();
});

test("deadline pauses gate admission while cancellation settles and host continuation preserves only the original cohort", async () => {
  const cancellation = Promise.withResolvers<void>();
  const states: string[] = [];
  const calls: string[] = [];
  let starts = 0;
  let token = "";
  const participants = [{ id: "a", configuration: { mode: "continuous" as const, repeatPromptSource: { kind: "raw" as const, value: "again" } } }];
  const execution = new Execution({ durationMs: 30, deadlinePolicy: "pause", repeatDelayMs: 0,
    participants: () => participants, prompt: async (id, scheduleId) => { calls.push(id); token = scheduleId; },
    flush: async () => {}, cancel: () => cancellation.promise,
    changed: state => states.push(state), onStart: async () => { starts++; }, log: () => {},
  });
  await execution.start();
  const stale = token;
  await delay(50);
  assert.equal(execution.state, "pausing");
  assert.equal(execution.blocked, true);
  assert.equal(execution.accept("a", stale), false);
  await assert.rejects(execution.continue(), /pausing/);
  await assert.rejects(execution.start(), /operator/);
  execution.completed(complete("a"));
  cancellation.resolve();
  await delay(0);
  assert.equal(execution.state, "paused");
  participants.push({ id: "late", configuration: { mode: "continuous", repeatPromptSource: { kind: "raw", value: "not in cohort" } } });
  await execution.continue();
  assert.notEqual(token, stale);
  assert.equal(execution.accept("a", stale), false);
  assert.deepEqual(calls, ["a", "a"]);
  assert.equal(starts, 2);
  await delay(50);
  assert.equal(execution.state, "paused");
  assert.deepEqual(states, ["running", "pausing", "paused", "running", "pausing", "paused"]);
  await execution.stop();
  await assert.rejects(execution.continue(), /pausing/);
});

test("host observers can terminally stop transitions without re-entering cleanup or starting late", async () => {
  let starts = 0;
  let stops = 0;
  let execution: Execution;
  execution = new Execution({ participants: () => [], prompt: async () => {}, flush: async () => {}, cancel: async () => {},
    changed: state => { if (state === "running" || state === "stopped") void execution.stop(); },
    onStart: async () => { starts++; }, onStop: async () => { stops++; }, log: () => {},
  });
  await execution.start();
  await execution.stop();
  assert.equal(execution.state, "stopped");
  assert.equal(starts, 0);
  assert.equal(stops, 1);
});

test("a deadline joins old startup before allowing continuation and explicit stop wins over pause", async () => {
  const startup = Promise.withResolvers<void>();
  const pause = Promise.withResolvers<void>();
  let calls = 0;
  const execution = new Execution({ durationMs: 25, deadlinePolicy: "pause",
    participants: () => [{ id: "a", configuration: { repeatPromptSource: { kind: "raw", value: "again" } } }],
    prompt: async () => { calls++; }, flush: async () => {}, cancel: async () => {},
    onStart: () => startup.promise, onPause: () => pause.promise, changed: () => {}, log: () => {},
  });
  const starting = execution.start();
  await delay(40);
  assert.equal(execution.state, "pausing");
  await assert.rejects(execution.continue(), /pausing/);
  startup.resolve(); pause.resolve();
  await starting;
  await delay(0);
  assert.equal(execution.state, "paused");
  await execution.continue();
  assert.equal(calls, 1, "old startup cannot nudge the next interval");
  await execution.stop();
  await delay(40);
  assert.equal(execution.state, "stopped");
  assert.equal(calls, 1);
});

test("invalid durations and delays fail before execution", () => {
  const options = { participants: () => [], prompt: async () => {}, flush: async () => {}, cancel: async () => {}, changed: () => {}, log: () => {} };
  for (const durationMs of [0, -1, Infinity, 1.5, 2 ** 32]) assert.throws(() => new Execution({ ...options, durationMs }));
  assert.throws(() => new Execution({ ...options, repeatDelayMs: -1 }));
});
