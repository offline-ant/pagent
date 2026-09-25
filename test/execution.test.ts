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
      { id: "a", configuration: { mode: "continuous", repeatPrompt: "do something" } },
      { id: "b", configuration: { repeatPrompt: "once" } },
      { id: "c", configuration: {} },
    ],
    prompt: async (id, text) => { calls.push(`${id}:${text}`); }, flush: async () => { flushed++; }, cancel: async () => {},
    changed: () => {}, onStart: async () => { starts++; }, onStop: async () => { stops++; }, log: () => {},
  });
  assert.equal(execution.state, "armed");
  assert.equal(execution.blocked, false);
  await execution.start();
  assert.deepEqual(calls, ["a:do something", "b:once"]);
  execution.completed(complete("a"));
  execution.completed(complete("b"));
  await delay(30);
  assert.equal(flushed, 1);
  assert.deepEqual(calls, ["a:do something", "b:once", "a:do something"]);
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
    participants: () => [{ id: "a", configuration: { mode: "continuous", repeatPrompt: "again" } }],
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
    participants: () => [{ id: "a", configuration: { mode: "continuous", repeatPrompt: "again" } }],
    prompt: async (_id, _text, token, current) => {
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

test("invalid durations and delays fail before execution", () => {
  const options = { participants: () => [], prompt: async () => {}, flush: async () => {}, cancel: async () => {}, changed: () => {}, log: () => {} };
  for (const durationMs of [0, -1, Infinity, 1.5, 2 ** 32]) assert.throws(() => new Execution({ ...options, durationMs }));
  assert.throws(() => new Execution({ ...options, repeatDelayMs: -1 }));
});
