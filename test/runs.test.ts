import assert from "node:assert/strict";
import test from "node:test";
import { Runs, MAX_ACTIVE_AGENTS, validateAgentId } from "../src/runs.ts";

for (const id of ["", "has space", "line\nbreak", "x".repeat(201), null]) {
  test(`invalid agent ID ${JSON.stringify(id)}`, () => assert.throws(() => validateAgentId(id)));
}

test("joins exact run receipts in requested order, independent cancellation and cycle checks", async () => {
  const runs = new Runs();
  const a = runs.start("a", "first", "input-a");
  const b = runs.start("b", "second", "input-b");
  const waiting = runs.wait(a.id, [b.id]);
  await assert.rejects(runs.wait(b.id, [a.id]), /cycle/);
  await assert.rejects(runs.wait(a.id, [a.id]), /cycle/);
  await assert.rejects(runs.wait(a.id, ["missing"]), /Unknown/);
  await assert.rejects(runs.wait(a.id, [b.id, b.id]), /unique/);
  runs.finish({ ...b, status: "complete", result: "answer" });
  assert.deepEqual(await waiting, [{ ...b, status: "complete", result: "answer" }]);
  const c = runs.start("c", "third", "input-c");
  const abort = new AbortController();
  const cancelled = runs.wait(a.id, [c.id], abort.signal);
  abort.abort(new Error("stop waiting"));
  await assert.rejects(cancelled, /stop waiting/);
  assert.equal(runs.get(c.id)?.status, "running", "a join does not own the independent child");
  runs.finish({ ...c, status: "cancelled" });
  assert.deepEqual((await runs.wait(a.id, [c.id, b.id])).map(run => run.status), ["cancelled", "complete"]);
});

test("active cap, rejected receipts, immutable IDs, and completion-order retention", async () => {
  const runs = new Runs();
  const slow = runs.start("slow", "one", "oldest-input");
  const rest = Array.from({ length: MAX_ACTIVE_AGENTS - 1 }, (_, i) => runs.start(`active-${i}`, `agent-${i}`, `input-${i}`));
  assert.throws(() => runs.start("overflow", "extra", "input"), /concurrently/);
  runs.reject({ id: "overflow", agentId: "extra", inputId: "input", status: "error", result: "", error: "limit" });
  assert.equal((await runs.wait(slow.id, ["overflow"]))[0].error, "limit");
  runs.reject({ id: "stale-schedule", agentId: "extra", inputId: "input", status: "cancelled", result: "" });
  assert.equal((await runs.wait(slow.id, ["stale-schedule"]))[0].status, "cancelled");
  assert.throws(() => runs.start("slow", "one", "different"), /already exists/);
  for (const run of rest) runs.finish({ ...run, status: "complete", result: run.id });
  for (let i = 0; i < 140; i++) {
    const run = runs.start(`quick-${i}`, "quick", `input-${i}`);
    runs.finish({ ...run, status: "complete", result: "quick" });
  }
  runs.finish({ ...slow, status: "complete", result: "most recent completion" });
  assert.equal((await runs.wait("reader", [slow.id]))[0].result, "most recent completion");
  await assert.rejects(runs.wait("reader", ["quick-0"]), /expired/);
  const receipt = runs.get(slow.id)!;
  receipt.result = "mutated copy";
  assert.equal(runs.get(slow.id)?.result, "most recent completion");
});
