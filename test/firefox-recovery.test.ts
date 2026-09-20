import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";
import type { HostEvent } from "../src/protocol.ts";

const ERROR = "Error: Unsupported native request.";

async function bounded<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs}ms`)), timeoutMs);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext, name: string): Promise<{ app: PagentApp; logs: string[] }> {
  const root = await mkdtemp(path.join(tmpdir(), `pagent-firefox-${name}-`));
  const logs: string[] = [];
  let app: PagentApp | undefined;
  t.after(async () => {
    try { if (app) await bounded(app.close(), 12_000); }
    finally {
      try { if (app) await bounded(app.browser.close(), 12_000); }
      finally { await rm(root, { recursive: true, force: true }); }
    }
  });
  app = await startPagent({ browser: "firefox", fake: true, headless: true, port: 0, directory: root,
    log: message => logs.push(message) });
  return { app, logs };
}

async function waitFor(app: PagentApp, expression: string): Promise<void> {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try { if (await app.browser.evaluateValue(expression) === true) return; }
    catch { /* The controlled runtime may be reconnecting after cancellation. */ }
    await delay(25);
  }
  throw new Error(`Timed out: ${expression}`);
}

async function outbox(app: PagentApp): Promise<HostEvent[]> {
  const text = await readFile(path.join(app.stateDirectory, "outbox.jsonl"), "utf8");
  return text.trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as HostEvent);
}

function hasError(records: HostEvent[]): boolean {
  return records.some(record => record.event.type === "error" && record.event.message === ERROR);
}

async function deliveredError(app: PagentApp): Promise<void> {
  // Associate the control error with a saved output record: the transient notice
  // alone is overwritten by the next `saved` event, even without a runtime reset.
  await app.browser.evaluateValue(`(() => {
    const main = $('#main');
    main.ensureTurn(main.inputs[0].id);
    const script = document.createElement('script');
    script.textContent = "aos.addEventListener('event', ({detail}) => { if (detail.event.type === 'error') document.querySelector('#main').outputs[0].apply(detail.event); });";
    document.body.append(script);
  })()`);
  await app.save();
  await app.flush();
  await app.browser.evaluateValue("aos.send({type:'unsupported'})");
  await waitFor(app, `$(\"#main\").state.notice === ${JSON.stringify(ERROR)}`);
  await app.flush();
  assert(hasError(await outbox(app)), "delivered semantic error must remain uncheckpointed");
  assert(!(await readFile(path.join(app.directory, "index.html"), "utf8")).includes(ERROR));
}

async function assertSavedError(app: PagentApp, revision: string): Promise<void> {
  const live = await app.browser.snapshot();
  const stored = await readFile(path.join(app.directory, "index.html"), "utf8");
  const checkpoint = await readFile(path.join(app.stateDirectory, "revisions", revision), "utf8");
  for (const html of [live, stored, checkpoint]) {
    assert(html.includes(ERROR), "semantic error must survive in live serialized HTML and the checkpoint");
    assert.match(html, /shadowrootserializable/);
  }
}

test("Firefox replays an uncheckpointed error before a save concurrent with console reset", { timeout: 60_000 }, async t => {
  const { app } = await fixture(t, "concurrent-save");
  await deliveredError(app);
  const resetting = assert.rejects(app.browser.evaluate("while(true){}", { timeoutMs: 100 }), /timed out.*runtime reset/s);
  await delay(250);
  let revision: string | undefined;
  try { revision = await app.save(); }
  catch (error) { assert.match(String(error), /disconnected|Runtime changed/i); }
  if (revision) await assertSavedError(app, revision);
  else assert(hasError(await outbox(app)), "a disconnected save must not discard the outbox");
  await resetting;
  await app.flush();
  await assertSavedError(app, await app.save());
  await app.flush();
  assert(!hasError(await outbox(app)), "only a checkpoint containing the error may retire it");
});

test("Firefox rejects a save whose snapshot crosses a runtime generation", { timeout: 60_000 }, async t => {
  const { app } = await fixture(t, "stale-snapshot");
  await deliveredError(app);
  const snapshot = app.browser.snapshot;
  let snapshotEntered: () => void = () => {};
  let resumeSnapshot: () => void = () => {};
  const entered = new Promise<void>(resolve => { snapshotEntered = resolve; });
  const resume = new Promise<void>(resolve => { resumeSnapshot = resolve; });
  app.browser.snapshot = async () => {
    snapshotEntered();
    await resume;
    return snapshot();
  };
  const saving = assert.rejects(app.save(), /Runtime changed.*saving/i);
  try {
    await bounded(entered, 5_000);
    await assert.rejects(app.browser.evaluate("while(true){}", { timeoutMs: 100 }), /timed out.*runtime reset/s);
    await app.flush();
    assert(hasError(await outbox(app)), "reconnection alone must not retire delivered events");
  } finally {
    resumeSnapshot();
    app.browser.snapshot = snapshot;
  }
  await saving;
  assert(hasError(await outbox(app)), "a stale-generation snapshot must not checkpoint the outbox");
  assert(!(await readFile(path.join(app.directory, "index.html"), "utf8")).includes(ERROR));
  await assertSavedError(app, await app.save());
});

test("Firefox stops on a persisted poisoned event receiver without automatic restart or shutdown hang", { timeout: 60_000 }, async t => {
  const { app, logs } = await fixture(t, "poisoned-receiver");
  const source = `aos.addEventListener('event', ({detail}) => {
    if (detail.event.type === 'error') while (true) {}
  });`;
  await app.browser.evaluateValue(`(() => {
    const script = document.createElement('script');
    script.id = 'poisoned-receiver';
    script.textContent = ${JSON.stringify(source)};
    document.body.append(script);
  })()`);
  await app.save();
  await app.flush();
  assert((await readFile(path.join(app.directory, "index.html"), "utf8")).includes(source),
    "the checkpoint must contain executable poison, not just an unsaved listener");
  const endpointFile = path.join(app.stateDirectory, "firefox", "WebDriverBiDiServer.json");
  const endpoint = JSON.parse(await readFile(endpointFile, "utf8")) as { ws_host: string; ws_port: number };
  await app.browser.evaluateValue("aos.send({type:'unsupported'})");
  const deadline = Date.now() + 2_000;
  while (!hasError(await outbox(app)) && Date.now() < deadline) await delay(10);
  assert(hasError(await outbox(app)), "poisoned delivery must first be journaled");
  const started = Date.now();
  await assert.rejects(bounded(app.flush(), 12_000), /disconnected/);
  assert(Date.now() - started < 12_000, "internal evaluation must stop within its bounded timeout");
  assert(logs.some(line => /runtime stopped/i.test(line)), logs.join("\n"));
  await assert.rejects(app.browser.evaluateValue("true"), /unavailable|stopped/i);
  await assert.rejects(fetch(`http://${endpoint.ws_host}:${endpoint.ws_port}/`, { signal: AbortSignal.timeout(1_000) }),
    "the original Firefox debugging port must be closed");
  const retained = await outbox(app);
  const stoppedLogs = [...logs];
  await delay(1_500);
  await assert.rejects(app.browser.evaluateValue("true"), /unavailable|stopped/i);
  assert.deepEqual(await outbox(app), retained, "no new ready/connected/replay loop may run after stopping");
  assert.deepEqual(logs, stoppedLogs, "poison must not cause repeating runtime failures");
  assert(hasError(retained), "the failed event remains available for explicit repair");
  await bounded(app.close(), 12_000);
  assert.deepEqual(await outbox(app), retained, "closing a stopped page must not save away its pending output");
});

test("Firefox context JSON preserves deep metadata and repeated references", { timeout: 60_000 }, async t => {
  const { app, logs } = await fixture(t, "context-json");
  let deep: object = { leaf: "deep-context-leaf" };
  for (let i = 0; i < 35; i++) deep = { nested: deep };
  const shared = { value: "repeated-context-value", nested: { intact: true } };
  const expected = { role: "user", content: [{ type: "text", text: "metadata history marker" }], timestamp: 1,
    providerMetadata: { deep, first: shared, second: shared } };
  await app.browser.evaluateValue(`(() => {
    const collect = pagent.collectContext;
    const message = ${JSON.stringify(expected)};
    message.providerMetadata.second = message.providerMetadata.first;
    pagent.collectContext = (agentId, id) => {
      const context = collect(agentId, id);
      context.history = [message, ...context.history];
      return context;
    };
    const input = $(\"#main\").inputs.at(-1);
    input.value = '/fake-inspect';
    return typeof $(\"#main\").submit(input.id) === "string";
  })()`);
  await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").outputs[0]?.messages.length === 1");
  const text = await app.browser.evaluateValue("$(\"#main\").outputs[0].messages[0].content.find(c => c.type === 'text').text");
  assert.equal(typeof text, "string");
  const inspected = JSON.parse(text as string) as { messages: Array<{ role: string; content: unknown }> };
  const message = inspected.messages.find(item => item.role === "user" && JSON.stringify(item.content).includes("metadata history marker"));
  assert.deepEqual(message, expected, "the final provider context must retain the entire original JSON message");
  assert(!JSON.stringify(message).includes("[truncated]"));
  await app.flush();
  assert.deepEqual(logs, []);
});

test("Firefox cancels an actual SDK console call, replays its result and accepts another prompt", { timeout: 60_000 }, async t => {
  const { app } = await fixture(t, 'sdk-console-cancel');
  const evaluate = app.browser.evaluate.bind(app.browser);
  app.browser.evaluate = (_code, options) => evaluate('window.agentEvaluationPending = true; new Promise(() => {})', options);
  try {
    await app.browser.evaluateValue(`(() => {
      const input = $(\"#main\").inputs[0];
      input.value = 'Run the local smoke tools';
      return typeof $(\"#main\").submit(input.id) === "string";
    })()`);
    await waitFor(app, 'window.agentEvaluationPending === true');
    await app.browser.evaluateValue("aos.send({type:'cancel',agentId:'main'})");
    await waitFor(app, '$(\"#main\").canSubmit && !$(\"#main\").state.busy');
    await app.flush();
    assert.equal(app.agents.get("main")!.busy, false);
    assert.equal(await app.browser.evaluateValue('typeof agentEvaluationPending'), 'undefined');
    const history = validateHistory(await app.browser.evaluateValue('pagent.collectContext(\"main\").history'));
    assert(history.some(message => message.role === 'toolResult' && message.toolName === 'console' && message.isError));
  } finally { app.browser.evaluate = evaluate; }
  await app.browser.evaluateValue(`(() => {
    const input = $(\"#main\").inputs.at(-1);
    input.value = '/fake-inspect';
    return typeof $(\"#main\").submit(input.id) === "string";
  })()`);
  await waitFor(app, '$(\"#main\").canSubmit && $(\"#main\").outputs.length === 2 && $(\"#main\").outputs[1].messages.length === 1');
  await app.save();
});
