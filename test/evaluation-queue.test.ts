import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import test from "node:test";
import { EvaluationQueue } from "../src/evaluation-queue.ts";

const cancelled = /Browser evaluation cancelled before execution/;

test("queued cancellation rejects immediately without running or advancing past the active job", { timeout: 1_000 }, async () => {
  const queue = new EvaluationQueue();
  const active = Promise.withResolvers<number>();
  const first = queue.enqueue(() => active.promise);
  const controller = new AbortController();
  let cancelledRan = false;
  const second = queue.enqueue(async () => { cancelledRan = true; }, controller.signal);
  let nextRan = false;
  const next = queue.enqueue(async () => { nextRan = true; return 3; });
  assert.equal(getEventListeners(controller.signal, "abort").length, 1);
  controller.abort();
  await assert.rejects(second, cancelled);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(cancelledRan, false);
  assert.equal(nextRan, false);
  active.resolve(1);
  assert.equal(await first, 1);
  assert.equal(await next, 3);
  assert.equal(cancelledRan, false);
});

test("already-aborted and cancelled-before-start jobs never execute", { timeout: 1_000 }, async () => {
  const queue = new EvaluationQueue();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(queue.enqueue(async () => assert.fail("already aborted job ran"), controller.signal), cancelled);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  const beforeStart = new AbortController();
  const pending = queue.enqueue(async () => assert.fail("cancelled job ran"), beforeStart.signal);
  beforeStart.abort();
  await assert.rejects(pending, cancelled);
  assert.equal(getEventListeners(beforeStart.signal, "abort").length, 0);
  assert.equal(await queue.enqueue(async () => 1), 1);
});

test("active cancellation belongs to the engine and the queue waits for its cleanup", { timeout: 1_000 }, async () => {
  const queue = new EvaluationQueue();
  const controller = new AbortController();
  const started = Promise.withResolvers<void>();
  const interrupted = Promise.withResolvers<void>();
  const cleanup = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const active = queue.enqueue(async () => {
    assert.equal(getEventListeners(controller.signal, "abort").length, 0, "waiting listener removed before engine starts");
    const abort = () => interrupted.resolve();
    controller.signal.addEventListener("abort", abort, { once: true });
    started.resolve();
    try {
      await interrupted.promise;
      throw new Error("engine cancelled");
    } finally {
      controller.signal.removeEventListener("abort", abort);
      cleaning.resolve();
      await cleanup.promise;
    }
  }, controller.signal);
  let settled = false;
  const rejected = assert.rejects(active, /engine cancelled/).then(() => { settled = true; });
  let nextRan = false;
  const next = queue.enqueue(async () => { nextRan = true; });
  await started.promise;
  controller.abort();
  await cleaning.promise;
  assert.equal(settled, false, "active rejection must wait for engine cleanup");
  assert.equal(nextRan, false);
  cleanup.resolve();
  await rejected;
  await next;
  assert.equal(nextRan, true);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("completion and synchronous failure remove listeners and leave the queue usable", { timeout: 1_000 }, async () => {
  const queue = new EvaluationQueue();
  const controller = new AbortController();
  assert.equal(await queue.enqueue(async () => 1, controller.signal), 1);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  await assert.rejects(queue.enqueue(() => { throw new Error("failed"); }, controller.signal), /failed/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.equal(await queue.enqueue(async () => 2), 2);
});
