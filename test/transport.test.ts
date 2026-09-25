import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";

async function eventually(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(message);
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} failed rendering remains unacknowledged and replay does not duplicate partially stored messages`, { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pagent-delivery-"));
    const logs: string[] = [];
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, port: 0, browser, headless: true, fake: true,
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: line => logs.push(line) });
      const session = app;
      const deliver = session.browser.deliver.bind(session.browser);
      let broken = false;
      session.browser.deliver = async record => {
        const event = record.event;
        if (!broken && event.type === "message" && event.phase === "end" && event.message && typeof event.message === "object" && "role" in event.message && event.message.role === "assistant") {
          broken = true;
          await session.browser.evaluateValue(`(() => {
            const output=$('#main').outputs[0]; window.goodRender=output.render;
            output.render=()=>{ throw new Error('Deliberate rendering failure after records persisted'); };
          })()`);
        }
        return deliver(record);
      };
      await session.browser.evaluateValue(`$('#main').prompt('/fake-say retained once')`);
      await eventually(() => broken && !session.busy, "run did not finish after failed rendering");
      await assert.rejects(session.flush(), /disconnected/);
      assert.match(await readFile(join(session.stateDirectory, "outbox.jsonl"), "utf8"), /retained once/);
      assert.ok(logs.some(line => line.includes("delivery paused")));
      assert.equal(await session.browser.evaluateValue(`$('#main').outputs[0].messages.length`), 1);
      await session.browser.evaluateValue(`(() => {
        $('#main').outputs[0].render=goodRender;
        aos.send({type:'ready',after:Number(document.documentElement.dataset.pagentSeq),agents:pagent.agents.map(a=>a.configuration)});
      })()`);
      await eventually(async () => await session.browser.evaluateValue(`$('#main').canSubmit && $('#main').result === 'retained once'`) === true, "repair/replay did not reconnect");
      await session.flush();
      const history = validateHistory(await session.browser.evaluateValue(`$('#main').messages`));
      assert.equal(history.length, 2, "replay repairs rendering without appending the same completed message twice");
      assert.equal(history[1].role, "assistant");
      await session.save();
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${browser} a restored element waits for its previous disposal without blocking page reconnection`, { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pagent-dispose-reload-'));
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, port: 0, browser, headless: true, fake: true,
        noSandbox: browser === 'chromium' && process.env.PAGENT_TEST_NO_SANDBOX === '1', log: () => {} });
      const session = app;
      await session.save();
      const previous = session.agents.get('main')!;
      const cancel = previous.cancel.bind(previous);
      previous.cancel = async () => { await delay(1_000); await cancel(); };
      await session.browser.evaluateValue(`$('#main').remove()`);
      await session.browser.reload();
      await eventually(async () => await session.browser.evaluateValue(`$('#main').canSubmit && $('#main').webBackend !== null`) === true, 'restored element never connected after old disposal');
      assert.notEqual(session.agents.get('main'), previous);
      assert.equal(session.busy, false);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${browser} human reload gates both element prompting and native submissions during cancellation`, { timeout: 40_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'pagent-reload-gate-'));
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, port: 0, browser, headless: true, fake: true,
        noSandbox: browser === 'chromium' && process.env.PAGENT_TEST_NO_SANDBOX === '1', log: () => {} });
      const session = app;
      await session.browser.evaluateValue(`$('#main').prompt('/fake-wait')`);
      await eventually(() => session.agents.get('main')!.busy, 'initial run did not start');
      const deliver = session.browser.deliver.bind(session.browser);
      let attempted = false;
      let blocked: unknown;
      session.browser.deliver = async record => {
        await deliver(record);
        if (!attempted && record.event.type === 'run' && record.event.run.status === 'cancelled') {
          attempted = true;
          blocked = await session.browser.evaluateValue(`(() => {
            let message=''; try { $('#main').prompt('/fake-say must not run'); } catch(error) { message=error.message; }
            aos.send({type:'submit',agentId:'main',id:$('#main').inputs.at(-1).id,runId:'during-reload'});
            return message;
          })()`);
        }
      };
      await session.browser.evaluateValue(`aos.send({type:'reload'})`);
      await eventually(async () => {
        try { return attempted && await session.browser.evaluateValue(`$('#main').canSubmit`) === true; }
        catch { return false; }
      }, 'reload did not settle');
      assert.match(String(blocked), /reload/i);
      await session.browser.evaluateValue(`$('#main').prompt('/fake-join during-reload')`);
      await eventually(async () => await session.browser.evaluateValue(`$('#main').run.status === 'complete'`) === true, 'join of rejected native run did not complete');
      assert.match(String(await session.browser.evaluateValue(`$('#main').result`)), /Workspace is busy/);
      assert.doesNotMatch(String(await session.browser.evaluateValue(`$('#main').result`)), /empty prompt|Unknown or expired/);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${browser} reconnect snapshot delivery never overtakes concurrent output`, { timeout: 30_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), "pagent-replay-order-"));
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, port: 0, browser, headless: true, fake: true,
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} });
      const session = app;
      const deliver = session.browser.deliver.bind(session.browser);
      let injected = false;
      const seen: number[] = [];
      session.browser.deliver = async record => {
        seen.push(record.seq);
        if (!injected && record.event.type === "connected") {
          injected = true;
          await session.browser.evaluateValue(`aos.send({type:'unsupported-during-connected-snapshot'})`);
          await delay(50);
        }
        return deliver(record);
      };
      await session.browser.evaluateValue(`aos.send({type:'ready',after:Number(document.documentElement.dataset.pagentSeq),agents:[{agentId:'main'}]})`);
      await eventually(async () => await session.browser.evaluateValue(`$('#main').state.notice.includes('Unsupported native request')`) === true, "concurrent error was skipped by higher reconnect cursor");
      await session.flush();
      assert.equal(injected, true);
      assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "every delivery stays ordered");
      assert.equal(new Set(seen).size, seen.length, "the queued live copy of replayed events is not delivered twice");
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
