import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";

async function until(app: PagentApp, expression: string, timeoutMs = 20_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try { if (await app.browser.evaluateValue(expression) === true) return; }
    catch (error) { last = error; } // Human reload replaces the execution context and module runtime.
    await delay(20);
  }
  throw new Error(`Timed out: ${expression}\n${String(last)}`);
}
async function json(app: PagentApp, expression: string): Promise<unknown> {
  return JSON.parse(String(await app.browser.evaluateValue(`JSON.stringify(${expression})`)));
}

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} agent spawns peers anywhere and joins their console work without holding the browser queue`, { timeout: 90_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `pagent-agents-${browser}-`));
    const options = { directory, browser, port: 0, headless: true, fake: true,
      noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" };
    const logs: string[] = [];
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ ...options, log: text => logs.push(text) });
      await app.browser.evaluateValue(`$('#main').inputs[0].value = 'Human draft survives delegation'`);
      assert.equal(typeof await app.browser.evaluateValue(`$('#main').prompt('/fake-delegate')`), "string");
      await until(app, `$('#main').run?.status === 'complete' && $('#research')?.run?.status === 'complete' && $('#review')?.run?.status === 'complete'`);
      assert.equal(app.agents.size, 3);
      assert.equal(await app.browser.evaluateValue(`$('#research').parentElement.localName`), "div");
      assert.equal(await app.browser.evaluateValue(`$('#main').inputs.at(-1).value`), "Human draft survives delegation");
      assert.deepEqual(await json(app, `['research','review'].map(id => document.body.dataset[id])`), ["done", "done"]);
      const history = validateHistory(await json(app, `$('#main').messages`));
      const joined = history.find(message => message.role === "toolResult" && message.toolName === "wait");
      assert.ok(joined?.role === "toolResult" && !joined.isError);
      assert.match(JSON.stringify(joined), /research answer/);
      assert.match(JSON.stringify(joined), /review answer/);
      assert.equal(history.filter(message => message.role === "user").length, 1);
      assert.equal(validateHistory(await json(app, `$('#research').messages`)).filter(message => message.role === "user").length, 1);

      // Idle-period and uncaught diagnostics are shared observations, not new turns.
      await app.browser.evaluateValue(`(() => {
        console.warn('idle warning visible to agents');
        setTimeout(() => { throw new Error('idle uncaught visible to agents'); }, 0);
        $('#research').insertAdjacentHTML('beforeend', '<agent-memory>research private memory</agent-memory>');
        $('#review').insertAdjacentHTML('beforeend', '<agent-memory>review private memory</agent-memory>');
      })()`);
      await delay(100);
      assert.equal(app.busy, false);
      await app.browser.evaluateValue(`$('#research').prompt('/fake-inspect')`);
      await until(app, `$('#research').run?.status === 'complete'`);
      const inspected = String(await app.browser.evaluateValue(`$('#research').outputs.at(-1).messages[0].content[0].text`));
      const context = JSON.parse(inspected) as { messages: Array<{ content: unknown }> };
      const live = JSON.stringify(context.messages.at(-1));
      assert.match(live, /idle warning visible to agents/);
      assert.match(live, /idle uncaught visible to agents/);
      assert.match(live, /research private memory/);
      assert.doesNotMatch(live, /review private memory|\[pagent assistant|\[pagent tool/);

      await app.save();
      await app.browser.reload();
      await until(app, `pagent.agents.every(a => a.canSubmit && a.webBackend !== null)`);
      assert.equal(await app.browser.evaluateValue(`$('#main').inputs.at(-1).value`), "Human draft survives delegation");
      const before = await json(app, `pagent.agents.map(a => [a.id,a.messages.length,a.result])`);
      await app.close();
      app = await startPagent({ ...options, log: text => logs.push(text) });
      assert.deepEqual(await json(app, `pagent.agents.map(a => [a.id,a.messages.length,a.result])`), before);
      assert.equal(app.busy, false);
      assert.deepEqual(logs, []);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${browser} reload reconciles a full set of attached agents before admitting restored identities`, { timeout: 70_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `pagent-agent-cap-${browser}-`));
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, browser, port: 0, headless: true, fake: true,
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} });
      await app.browser.evaluateValue(`(() => {
        for(let i=0;i<31;i++) { const a=document.createElement('p-agent'); a.id='cap-'+i; document.body.append(a); }
      })()`);
      await until(app, `pagent.agents.length === 32 && pagent.agents.every(a=>a.canSubmit && a.webBackend)`);
      await app.save();
      await app.browser.evaluateValue(`$('#cap-0').remove()`);
      const end = Date.now() + 10_000;
      while(app.agents.has('cap-0') && Date.now() < end) await delay(20);
      assert.equal(app.agents.has('cap-0'), false);
      await app.flush();
      await app.browser.evaluateValue(`(() => { const a=document.createElement('p-agent'); a.id='replacement'; document.body.append(a); })()`);
      await until(app, `$('#replacement').canSubmit && $('#replacement').webBackend !== null`);
      await app.browser.reload();
      await until(app, `pagent.agents.length === 32 && pagent.agents.every(a=>a.canSubmit && a.webBackend) && $('#cap-0') !== null && $('#replacement') === null`);
      await app.flush();
      assert.equal(app.agents.has('cap-0'), true);
      assert.equal(app.agents.has('replacement'), false);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });

  test(`${browser} independent cancellation, disposal acknowledgment, rejected receipts, and admission limits`, { timeout: 90_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `pagent-agents-limits-${browser}-`));
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, browser, port: 0, headless: true, fake: true,
        noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: () => {} });
      await app.browser.evaluateValue(`(() => {
        const a = document.createElement('p-agent'); a.id='slow'; document.body.append(a);
        window.slowRun = a.prompt('/fake-wait');
        $('#main').prompt('/fake-join ' + slowRun);
      })()`);
      await until(app, `$('#main').status === 'waiting'`);
      await app.browser.evaluateValue(`$('#main').cancel()`);
      await until(app, `$('#main').run.status === 'cancelled'`);
      assert.equal(await app.browser.evaluateValue(`$('#slow').status`), "running");
      await app.browser.evaluateValue(`$('#slow').remove()`);
      const end = Date.now() + 10_000;
      while (app.agents.has("slow") && Date.now() < end) await delay(20);
      assert.equal(app.agents.has("slow"), false);
      await app.flush(); // Includes disposal acknowledgment before ID reuse.
      await app.browser.evaluateValue(`(() => {
        const a = document.createElement('p-agent'); a.id='slow'; document.body.append(a);
        return a.prompt('/fake-say replacement only');
      })()`);
      await until(app, `$('#slow').result === 'replacement only' && $('#slow').status === 'idle'`);
      assert.equal(validateHistory(await json(app, `$('#slow').messages`)).length, 2);
      await app.browser.evaluateValue(`$('#slow').prompt('/fake-wait')`);
      const engine = app.agents.get('slow')!;
      const started = Date.now() + 5_000;
      while (!engine.busy && Date.now() < started) await delay(20);
      assert.equal(engine.busy, true);
      await delay(50); // Enter the faux provider before testing the embedding API's cancellation.
      await engine.cancel();
      await until(app, `$('#slow').run.status === 'cancelled'`);

      await app.browser.evaluateValue(`(() => {
        window.limitRuns=[];
        for(let i=0;i<9;i++) {
          const a=document.createElement('p-agent'); a.id='limit-'+i; document.body.append(a);
          limitRuns.push(a.prompt('/fake-wait'));
        }
      })()`);
      await until(app, `pagent.agents.filter(a => a.id.startsWith('limit-') && a.status === 'running').length === 8 && $('#limit-8').run?.status === 'error'`);
      assert.match(String(await app.browser.evaluateValue(`$('#limit-8').run.error`)), /concurrently/);
      await app.browser.evaluateValue(`$('#limit-0').cancel()`);
      await until(app, `$('#limit-0').run.status === 'cancelled'`);
      await app.browser.evaluateValue(`$('#main').prompt('/fake-join '+limitRuns[8])`);
      await until(app, `$('#main').run.status === 'complete'`);
      assert.match(String(await app.browser.evaluateValue(`$('#main').result`)), /concurrently/);
      assert.doesNotMatch(String(await app.browser.evaluateValue(`$('#main').result`)), /Unknown or expired/);
      await app.browser.evaluateValue(`aos.send({type:'reload'})`);
      await until(app, `pagent.agents.every(a=>a.canSubmit)`);
      assert.equal(app.busy, false);
    } finally { await app?.close(); await rm(directory, { recursive: true, force: true }); }
  });
}
