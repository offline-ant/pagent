import assert from "node:assert/strict";
import { access, appendFile, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPagent, type PagentApp, type PagentOptions } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";

async function waitFor(app: PagentApp, expression: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try { if (await app.browser.evaluateValue(expression) === true) return; }
    catch (error) { lastError = error; } // The initial faux turn deliberately reloads its page.
    await delay(20);
  }
  throw new Error(`Timed out: ${expression}\n${String(lastError)}`);
}

async function quickly<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Operation did not settle within 3 seconds")), 3_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function withApp(run: (app: PagentApp) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-lifecycle-"));
  let app: PagentApp | undefined;
  try {
    app = await startPagent({ directory: root, browser: "chromium", port: 0, headless: true, fake: true,
      noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1" });
    await run(app);
  } finally {
    // A failing assertion must still abort the faux provider's 60-second wait.
    await app?.agents.get("main")?.cancel();
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function submit(app: PagentApp, prompt: string): Promise<void> {
  assert.equal(await app.browser.evaluateValue(`(() => {
    const input = $(\"#main\").inputs.at(-1);
    input.value = ${JSON.stringify(prompt)};
    return typeof $(\"#main\").submit(input.id) === "string";
  })()`), true);
}

async function delayContext(app: PagentApp): Promise<void> {
  await app.browser.evaluateValue(`(() => {
    const collect = pagent.collectContext.bind(pagent);
    window.contextStarted = false;
    window.contextFinished = false;
    pagent.collectContext = async (agentId, id) => {
      if (id !== undefined) {
        window.contextStarted = true;
        await new Promise(resolve => setTimeout(resolve, 500));
        window.contextFinished = true;
      }
      return collect(agentId, id);
    };
  })()`);
}

test("a new turn preserves the complete conversation through a mid-turn reload", { timeout: 40_000 }, async () => {
  await withApp(async app => {
    await submit(app, "Build the initial page");
    await waitFor(app, `!$(\"#main\").state.busy && $(\"#main\").outputs[0]?.messages.some(m =>
      m.role === 'assistant' && m.content.some(c => c.type === 'text' && c.text.startsWith('Pagent smoke complete.')))`, 25_000);
    await app.save();
    await app.flush();

    const prior = validateHistory(await app.browser.evaluateValue("pagent.collectContext('main').history"));
    await submit(app, "/fake-wait");
    await delay(100);
    assert.equal(app.agents.get("main")!.busy, true);
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs[0].messages.length"), 7,
      "a new turn never clears previous output");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs[1].messages.length"), 0);

    await app.browser.reload();
    assert.equal(await app.browser.evaluateValue("$(\"#main\").inputs[0].value"), "Build the initial page");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").inputs[1].value"), "/fake-wait");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs.length"), 2);
    await app.browser.evaluateValue("aos.send({type:'cancel',agentId:'main'})");
    await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").canSubmit");
    await app.save();
    await app.browser.reload();
    const history = validateHistory(await app.browser.evaluateValue("pagent.collectContext(\"main\").history"));
    assert.deepEqual(history.slice(0, prior.length), prior, "reload and cancellation retain every earlier message");
    assert.deepEqual(history.filter(message => message.role === "user").map(message => message.content),
      [[{ type: "text", text: "Build the initial page" }], [{ type: "text", text: "/fake-wait" }]]);
    assert.equal(history.some(message => message.role === "toolResult"), true);
    assert.match(JSON.stringify(history), /Pagent smoke complete/);
    assert.doesNotMatch(JSON.stringify(history), /Wait completed/);
    assert.equal(await app.browser.evaluateValue("$(\"#main\").canSubmit"), true);
  });
});

test("immediate cancel during asynchronous context collection never submits to the engine", { timeout: 15_000 }, async () => {
  await withApp(async app => {
    await delayContext(app);
    let submissions = 0;
    const originalSubmit = app.agents.get("main")!.submit.bind(app.agents.get("main")!);
    app.agents.get("main")!.submit = input => { submissions++; return originalSubmit(input); };
    assert.equal(await app.browser.evaluateValue(`(() => {
      const input = $(\"#main\").inputs.at(-1);
      input.value = '/fake-wait';
      const accepted = typeof $(\"#main\").submit(input.id) === "string";
      aos.send({type:'cancel',agentId:'main'});
      return accepted;
    })()`), true);
    // Also allow cancellation to prevent collection entirely; wait past its delay
    // so an early idle UI cannot hide a submission that starts afterwards.
    await delay(600);
    await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").canSubmit");
    await app.flush();
    assert.equal(submissions, 0, "cancelled collection must not start the provider wait later");
    assert.equal(app.agents.get("main")!.busy, false);
    await quickly(app.close());
  });
});

test("close during asynchronous context collection does not start a provider wait", { timeout: 15_000 }, async () => {
  await withApp(async app => {
    await delayContext(app);
    let submissions = 0;
    const engine = app.agents.get("main")!;
    const originalSubmit = engine.submit.bind(engine);
    engine.submit = input => { submissions++; return originalSubmit(input); };
    await submit(app, "/fake-wait");
    await waitFor(app, "window.contextStarted && !window.contextFinished");
    await quickly(app.close());
    assert.equal(submissions, 0, "shutdown must invalidate the pending context collection");
    assert.equal(engine.busy, false);
  });
});

test("save captures edited memory before a concurrently requested reload", { timeout: 15_000 }, async () => {
  await withApp(async app => {
    const memory = "Unsaved memory must be captured before navigation";
    await app.browser.evaluateValue(`document.querySelector('agent-memory').textContent = ${JSON.stringify(memory)}`);
    const snapshot = app.browser.snapshot.bind(app.browser);
    let snapshotStarted: () => void = () => {};
    const entered = new Promise<void>(resolve => { snapshotStarted = resolve; });
    app.browser.snapshot = async () => {
      snapshotStarted();
      await delay(500);
      return snapshot();
    };
    try {
      const saving = app.save();
      await entered;
      const reloading = app.browser.reload();
      const [revision] = await Promise.all([saving, reloading]);
      assert((await readFile(path.join(app.stateDirectory, "revisions", revision), "utf8")).includes(memory),
        "the requested revision must contain memory edited before reload");
      assert((await readFile(path.join(app.directory, "index.html"), "utf8")).includes(memory),
        "the stored root document must contain the edited memory");
      assert.equal(await app.browser.evaluateValue("document.querySelector('agent-memory').textContent"), memory);
    } finally { app.browser.snapshot = snapshot; }
  });
});

test("a corrupt outbox releases the startup lock and resetUI archives it before recovery", { timeout: 20_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-outbox-recovery-"));
  const options: PagentOptions = { directory: root, browser: "chromium", port: 0, headless: true, fake: true,
    noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} };
  let app: PagentApp | undefined;
  try {
    app = await startPagent(options);
    const stateDirectory = app.stateDirectory;
    await app.close();
    app = undefined;
    const outbox = path.join(stateDirectory, "outbox.jsonl");
    await appendFile(outbox, "not valid JSON\n");
    const damaged = await readFile(outbox, "utf8");
    await assert.rejects(async () => { app = await startPagent(options); });
    await assert.rejects(access(path.join(stateDirectory, "host.lock")), { code: "ENOENT" });
    assert.equal(await readFile(outbox, "utf8"), damaged, "failed startup must preserve the damaged evidence");

    app = await startPagent({ ...options, resetUI: true });
    const recovery = path.join(stateDirectory, "recovery");
    const archives = (await readdir(recovery, { recursive: true })).filter(name => path.basename(name) === "outbox.jsonl");
    assert.equal(archives.length, 1);
    assert.equal(await readFile(path.join(recovery, archives[0]), "utf8"), damaged);
    assert.doesNotMatch(await readFile(outbox, "utf8"), /not valid JSON/);
    assert.equal(await app.browser.evaluateValue("$(\"#main\").canSubmit"), true);
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs.length"), 0);
    assert.deepEqual(await app.browser.evaluateValue("pagent.collectContext(\"main\").history"), []);
    await app.flush();
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the UI becomes ready only after final checkpointing accepts another submission", { timeout: 15_000 }, async () => {
  await withApp(async app => {
    const snapshot = app.browser.snapshot.bind(app.browser);
    let calls = 0;
    let entered: () => void = () => {};
    const finalCheckpoint = new Promise<void>(resolve => { entered = resolve; });
    app.browser.snapshot = async () => {
      if (++calls === 2) { entered(); await delay(300); }
      return snapshot();
    };
    try {
      await submit(app, '/fake-inspect');
      await finalCheckpoint;
      assert.equal(app.agents.get("main")!.busy, false, 'the model finished before the host checkpoint');
      assert.equal(await app.browser.evaluateValue('$(\"#main\").canSubmit'), false);
      await waitFor(app, '$(\"#main\").canSubmit');
      await submit(app, '/fake-inspect');
      await waitFor(app, '$(\"#main\").canSubmit && $(\"#main\").outputs.length === 2');
      assert.equal(await app.browser.evaluateValue('$(\"#main\").outputs[1].messages.length'), 1);
      assert.equal(await app.browser.evaluateValue('$(\"#main\").state.error'), false);
    } finally { app.browser.snapshot = snapshot; }
  });
});

test("reconnect drains events emitted during replay before advancing the connected cursor", { timeout: 15_000 }, async () => {
  await withApp(async app => {
    const deliver = app.browser.deliver.bind(app.browser);
    let injected = false;
    app.browser.deliver = async record => {
      if (!injected) {
        injected = true;
        await app.browser.evaluateValue("aos.send({type:'deliberately-unsupported'})");
        await delay(50); // Ensure the new host event is enqueued during replay.
      }
      await deliver(record);
    };
    try {
      await app.browser.evaluateValue("aos.send({type:'ready',agents:pagent.agents.map(a=>a.configuration),after:0})");
      await waitFor(app, "$(\"#main\").state.notice.includes('Unsupported native request')");
      await app.flush();
      assert.equal(injected, true);
    } finally { app.browser.deliver = deliver; }
  });
});

test("controlled reload restores the native port even after delivery disconnects", { timeout: 15_000 }, async () => {
  await withApp(async app => {
    await app.browser.evaluateValue("window.aos = undefined");
    await app.save(); // The saved event attempts delivery through the removed port.
    await assert.rejects(app.flush(), /disconnected/i);
    await app.browser.reload();
    await app.flush();
    assert.equal(await app.browser.evaluateValue("typeof aos.send"), "function");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").canSubmit"), true);
    await submit(app, "/fake-inspect");
    await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").outputs[0]?.messages.length === 1");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs[0].messages[0].role"), "assistant");
  });
});
