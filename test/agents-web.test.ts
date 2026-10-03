import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { WebAttention } from "pi-browser/web";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";
import type { HostEvent } from "../src/protocol.ts";
import { brokerExit, isolateBrokers, ResearchObserver, researchProfile } from "./research.ts";

async function until(app: PagentApp, expression: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await app.browser.evaluateValue(expression) === true) return;
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${expression}`);
}

async function attention(app: PagentApp, id: string): Promise<WebAttention> {
  await until(app, `$('#${id}').webAttention !== null && !$('#${id}').shadowRoot.querySelector('[data-web-attention]').hidden`);
  return JSON.parse(String(await app.browser.evaluateValue(`JSON.stringify($('#${id}').webAttention)`))) as WebAttention;
}

for (const research of ["chromium", "firefox"] as const) {
  test(`${research} research and attention are independent for nested agents in one workspace`, { timeout: 110_000 }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `pagent-agents-web-${research}-`));
    const restoreTmpdir = isolateBrokers(directory);
    const environment = { PI_WEB_BACKEND: process.env.PI_WEB_BACKEND, PI_BROWSER_HEADLESS: process.env.PI_BROWSER_HEADLESS };
    process.env.PI_WEB_BACKEND = "browser";
    process.env.PI_BROWSER_HEADLESS = "true";
    const requests = new Map<string, number>();
    const server = createServer((request, response) => {
      const url = request.url ?? "/";
      requests.set(url, (requests.get(url) ?? 0) + 1);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end("<!doctype html><title>Captcha fixture</title><main><p>Please complete the following challenge to confirm you are human.</p><p>Local test fixture; no external research or provider requests.</p></main>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const logs: string[] = [];
    const observers = new Map<string, ResearchObserver>();
    let app: PagentApp | undefined;
    try {
      app = await startPagent({ directory, browser: research, port: 0, headless: true, fake: true,
        noSandbox: research === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: message => logs.push(message) });
      const workspace = app;
      // Each agent's research broker also accepts this observer, acting as the person at its research window.
      function evaluateResearch(id: string, tab: string, expression: string): Promise<unknown> {
        let observer = observers.get(id);
        if (!observer) observers.set(id, observer = new ResearchObserver(workspace.stateDirectory, id, research));
        return observer.evaluate(tab, expression);
      }
      const browserPid = async (id: string) => (JSON.parse(await readFile(join(researchProfile(workspace.stateDirectory, id, research), ".pi-browser-owner", "owner.json"), "utf8")) as { browserPid: number; browser: string });
      async function correct(id: string, request: WebAttention): Promise<void> {
        await evaluateResearch(id, request.tab, `(() => {
          document.title = 'Local article ${id}';
          document.body.innerHTML = '<main><h1>Verified article ${id}</h1><p>Corrected content for ${id} only.</p></main>';
          window.humanCorrection = ${JSON.stringify(id)};
        })()`);
        await workspace.browser.evaluateValue(`$('#${id}').shadowRoot.querySelector('[data-web-continue]').click()`);
        await until(workspace, `$('#${id}').run.status === 'complete' && $('#${id}').canSubmit`);
        await workspace.flush();
        const history = validateHistory(await workspace.browser.evaluateValue(`$('#${id}').messages`));
        const fetched = history.findLast(message => message.role === "toolResult" && message.toolName === "web_fetch");
        assert(fetched?.role === "toolResult" && !fetched.isError, JSON.stringify(fetched));
        assert.match(JSON.stringify(fetched.content), new RegExp(`Corrected content for ${id} only`));
        assert.equal(await evaluateResearch(id, request.tab, "window.humanCorrection"), id);
        assert.equal(requests.get(`/${id}`), 1, "Continue and retry retain the original research DOM without navigation");
      }

      await app.browser.evaluateValue(`(() => {
        const container = document.createElement('div'); container.id = 'research-container'; $('#main').append(container);
        for (const id of ['alpha','beta']) {
          const agent = document.createElement('p-agent'); agent.id = id; container.append(agent);
        }
      })()`);
      await until(app, "pagent.agents.every(a => a.canSubmit && a.webBackend !== null)");
      assert.equal(app.agents.size, 3);
      await app.browser.evaluateValue(`(() => {
        window.researchEvents = {main: [], alpha: [], beta: []};
        for (const agent of pagent.agents) agent.addEventListener('progress', ({detail}) => {
          if (['web-progress','web-attention'].includes(detail.event.type)) researchEvents[agent.id].push(detail);
        });
        window.workspaceMarker = 'retained';
        for (const id of ['alpha','beta']) $('#'+id).prompt('/fake-fetch ' + ${JSON.stringify(origin)} + '/' + id);
      })()`);
      const alpha = await attention(app, "alpha");
      const beta = await attention(app, "beta");
      assert.notEqual(alpha.id, beta.id, "each agent owns separate intervention authority");
      assert.equal(alpha.url, `${origin}/alpha`);
      assert.equal(beta.url, `${origin}/beta`);
      const pids = new Map<string, number>();
      for (const [id, request] of [["alpha", alpha], ["beta", beta]] as const) {
        assert.equal(await app.browser.evaluateValue(`$('#${id}').parentElement.localName`), "div");
        assert.equal(app.agents.get(id)!.busy, true);
        const owner = await browserPid(id);
        assert.equal(owner.browser, research, `${id}'s SHA256 profile is owned by its own research browser of the workspace engine`);
        pids.set(id, owner.browserPid);
        assert.equal(await evaluateResearch(id, request.tab, "typeof window.aos"), "undefined");
        assert.equal(requests.get(`/${id}`), 1);
        const progress = await app.browser.evaluateValue(`$('#${id}').webProgress`);
        assert.equal(typeof progress, "string");
        assert.match(progress as string, new RegExp(`${origin}/${id}`));
      }
      assert.notEqual(pids.get("alpha"), pids.get("beta"), "no shared profile/process ownership");
      assert.equal(await app.browser.evaluateValue("$('#main').webAttention"), null);
      assert.equal(await app.browser.evaluateValue("$('#main').webProgress"), "");
      const betaProgress = await app.browser.evaluateValue("$('#beta').webProgress");

      // One workspace dropdown updates every engine and UI without rerouting active calls.
      await app.browser.evaluateValue(`(() => {
        const select = $('#alpha').shadowRoot.querySelector('[data-web-backend]');
        select.value = 'codex'; select.dispatchEvent(new Event('change'));
      })()`);
      await until(app, "pagent.agents.every(a => a.webBackend?.override === 'codex')");
      for (const engine of app.agents.values()) {
        assert.deepEqual(engine.getBackendState(), app.getBackendState());
      }
      assert.equal(app.getBackendState().effective, "codex");
      assert.equal(process.env.PI_WEB_BACKEND, "browser");
      assert.deepEqual(await attention(app, "alpha"), alpha);
      assert.deepEqual(await attention(app, "beta"), beta);
      assert.equal(app.agents.get("alpha")!.busy, true);
      assert.equal(app.agents.get("beta")!.busy, true);
      for (const id of ["alpha", "beta"]) assert.equal((await browserPid(id)).browserPid, pids.get(id));

      // A valid peer attention ID is not authority to continue or cancel this agent.
      await app.browser.evaluateValue(`aos.send({type:'web-continue',agentId:'alpha',id:${JSON.stringify(beta.id)}})`);
      await until(app, "$('#alpha').state.notice.includes('no longer active')");
      await app.browser.evaluateValue(`aos.send({type:'web-cancel',agentId:'beta',id:${JSON.stringify(alpha.id)}})`);
      await until(app, "$('#beta').state.notice.includes('no longer active')");
      assert.deepEqual(await attention(app, "alpha"), alpha);
      assert.deepEqual(await attention(app, "beta"), beta);

      await app.browser.evaluateValue("$('#alpha').shadowRoot.querySelector('[data-web-cancel]').click()");
      await until(app, "$('#alpha').run.status === 'cancelled' && $('#alpha').canSubmit");
      await app.flush();
      assert.equal(app.agents.get("alpha")!.busy, false);
      assert.equal(app.agents.get("beta")!.busy, true, "cancelling alpha leaves beta's inference and attention active");
      assert.equal(app.busy, true);
      assert.equal(await app.browser.evaluateValue("$('#alpha').webAttention"), null);
      assert.equal(await app.browser.evaluateValue("$('#alpha').webProgress"), "");
      assert.deepEqual(await attention(app, "beta"), beta);
      assert.equal(await app.browser.evaluateValue("$('#beta').webProgress"), betaProgress);
      assert.equal(await evaluateResearch("alpha", alpha.tab, "document.title"), "Captcha fixture", "cancel preserves alpha's research tab");

      // Reset before another invocation: no Codex credentials or service are ever used.
      await app.browser.evaluateValue("aos.send({type:'backend-set',override:null})");
      await until(app, "pagent.agents.every(a => a.webBackend?.override === null && a.webBackend.effective === 'browser')");
      await app.browser.evaluateValue(`$('#alpha').prompt(${JSON.stringify(`/fake-fetch ${origin}/alpha`)})`);
      const resumed = await attention(app, "alpha");
      assert.equal(resumed.tab, alpha.tab);
      assert.notEqual(resumed.id, alpha.id);
      assert.deepEqual(await attention(app, "beta"), beta);
      await correct("alpha", resumed);
      assert.deepEqual(await attention(app, "beta"), beta, "alpha's successful continuation cannot settle beta");
      assert.equal(await app.browser.evaluateValue("$('#beta').webProgress"), betaProgress);
      assert.equal(app.agents.get("beta")!.busy, true);
      await correct("beta", beta);
      assert.equal(app.busy, false);
      for (const id of ["alpha", "beta"]) assert.equal((await browserPid(id)).browserPid, pids.get(id), "backend updates and retry preserve both research processes");
      assert.equal(await app.browser.evaluateValue("window.workspaceMarker"), "retained");
      assert.equal(await app.browser.evaluateValue("location.href"), app.url);
      assert.equal(await app.browser.evaluateValue("typeof aos.send"), "function");
      assert.equal(await app.browser.evaluateValue("$('#main').messages.length"), 0);
      const events = JSON.parse(String(await app.browser.evaluateValue("JSON.stringify(researchEvents)"))) as Record<string, HostEvent[]>;
      assert.deepEqual(events.main, [], "nested agents' research events never reach the enclosing main agent");
      for (const id of ["alpha", "beta"]) {
        assert(events[id].some(record => record.event.type === "web-progress"));
        assert(events[id].some(record => record.event.type === "web-attention" && record.event.request));
        assert(events[id].some(record => record.event.type === "web-attention" && record.event.request === null));
        for (const record of events[id]) {
          assert.equal(record.agentId, id, "current research events are delivered only to their owning element");
          assert.equal(typeof record.runId, "string");
          assert.equal(typeof record.requestId, "string");
          if (record.event.type === "web-attention" && record.event.request) assert.equal(record.event.request.url, `${origin}/${id}`);
        }
        assert.equal(await app.browser.evaluateValue(`$('#${id}').webAttention`), null);
        assert.equal(await app.browser.evaluateValue(`$('#${id}').shadowRoot.querySelector('[data-web-progress]').hidden`), true);
      }
      assert.deepEqual(logs, []);
    } finally {
      const brokersExited = await brokerExit(directory);
      for (const observer of observers.values()) await observer.close();
      await app?.close();
      await brokersExited();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      restoreTmpdir();
      await rm(directory, { recursive: true, force: true });
    }
  });
}
