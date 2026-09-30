import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { setImmediate as nextTurn } from "node:timers/promises";
import test from "node:test";
import { installOperatorControls } from "../src/terminal.ts";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = "";
  output.on("data", chunk => { text += String(chunk); });
  return { input, output, text: () => text };
}

test("operator lines continue explicitly and finish closes once", async () => {
  const io = streams();
  let continuations = 0;
  let closes = 0;
  const dispose = installOperatorControls({
    async continue() { continuations++; },
    async close() { closes++; },
  }, io);
  assert.match(io.text(), /continue.*finish/);
  io.input.write("\nunknown\n continue \r\n");
  await nextTurn();
  assert.equal(continuations, 1);
  assert.equal(closes, 0);
  assert.match(io.text(), /Continued execution/);
  io.input.write("finish\ncontinue\nfinish\n");
  await nextTurn();
  assert.equal(continuations, 1);
  assert.equal(closes, 1);
  dispose();
  dispose();
  io.input.destroy();
  io.output.destroy();
});

test("operator continuation errors are reported without retry", async () => {
  const io = streams();
  let attempts = 0;
  const dispose = installOperatorControls({
    async continue() { attempts++; throw new Error("Execution is not paused."); },
    async close() { throw new Error("close failed"); },
  }, io);
  io.input.write("continue\n");
  await nextTurn();
  assert.equal(attempts, 1);
  assert.match(io.text(), /Continue failed: Error: Execution is not paused/);
  io.input.write("finish\n");
  await nextTurn();
  assert.match(io.text(), /Finish failed: Error: close failed/);
  dispose();
  io.input.destroy();
  io.output.destroy();
});

test("finish is not queued behind continuation and duplicate continuation is not deferred", async () => {
  const io = streams();
  const pending = Promise.withResolvers<void>();
  let attempts = 0;
  let closes = 0;
  const dispose = installOperatorControls({
    async continue() { attempts++; await pending.promise; },
    async close() { closes++; },
  }, io);
  io.input.write("continue\ncontinue\nfinish\n");
  await nextTurn();
  assert.equal(attempts, 1);
  assert.equal(closes, 1);
  assert.match(io.text(), /Continuation already in progress/);
  pending.resolve();
  await nextTurn();
  assert.doesNotMatch(io.text(), /Continued execution/);
  dispose();
  io.input.destroy();
  io.output.destroy();
});

test("disposal and EOF remove operator input without closing the host", async () => {
  for (const mode of ["dispose", "eof"] as const) {
    const io = streams();
    let called = 0;
    const dispose = installOperatorControls({
      async continue() { called++; }, async close() { called++; },
    }, io);
    if (mode === "dispose") { dispose(); io.input.write("continue\nfinish\n"); }
    else io.input.end();
    await nextTurn();
    assert.equal(called, 0);
    assert.equal(io.input.listenerCount("data"), 0);
    dispose();
    io.input.destroy();
    io.output.destroy();
  }
});

test("default stdin pipe does not keep the host alive after finish or disposal", { timeout: 10_000 }, async () => {
  for (const mode of ["finish", "dispose"] as const) {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", `
      import { installOperatorControls } from ${JSON.stringify(new URL("../src/terminal.ts", import.meta.url).href)};
      const dispose = installOperatorControls({
        async continue() {}, async close() { console.log('CLOSED'); }
      });
      ${mode === "dispose" ? "setTimeout(dispose, 20);" : ""}
    `], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let sent = false;
    child.stdout.on("data", chunk => {
      output += String(chunk);
      if (mode === "finish" && !sent) { sent = true; child.stdin.write("finish\n"); }
    });
    child.stderr.on("data", chunk => { output += String(chunk); });
    // Deliberately leave the parent's stdin writer open. Before the fix the
    // child's paused PipeWrap prevented natural exit until this timer killed it.
    const timer = setTimeout(() => child.kill("SIGKILL"), 3_000);
    try {
      const result = await new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
      assert.deepEqual(result, { code: 0, signal: null }, `${mode}: ${output}`);
      if (mode === "finish") assert.match(output, /CLOSED/);
    } finally {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      child.stdin.destroy();
    }
  }
});

test("operator input errors are reported and detach controls", async () => {
  const io = streams();
  let called = 0;
  const dispose = installOperatorControls({
    async continue() { called++; }, async close() { called++; },
  }, io);
  io.input.emit("error", new Error("input lost"));
  io.input.write("continue\nfinish\n");
  await nextTurn();
  assert.equal(called, 0);
  assert.match(io.text(), /Operator input: input lost/);
  assert.equal(io.input.listenerCount("data"), 0);
  dispose();
  io.input.destroy();
  io.output.destroy();
});
