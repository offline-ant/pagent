import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { BrowserProcessLauncher, type NativeBrowserProcess } from "pi-browser";
import { Bidi, object, remoteValue } from "pi-browser/bidi";
import { Cdp } from "pi-browser/cdp";
import type { WebAttention } from "pi-browser/web";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";

async function waitFor(app: PagentApp, expression: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await app.browser.evaluateValue(expression) === true) return; }
    catch (error) { last = error; }
    await delay(30);
  }
  throw new Error(`Timed out waiting for ${expression}: ${String(last)}`);
}

async function submit(app: PagentApp, url: string): Promise<void> {
  assert.equal(await app.browser.evaluateValue(`(() => {
    const input = $(\"#main\").inputs.at(-1);
    input.value = ${JSON.stringify(`/fake-fetch ${url}`)};
    return typeof $(\"#main\").submit(input.id) === "string";
  })()`), true);
}

async function attention(app: PagentApp): Promise<WebAttention> {
  await waitFor(app, "Boolean($(\"#main\").webAttention && !$(\"#main\").shadowRoot.querySelector('[data-web-attention]').hidden)");
  const json = await app.browser.evaluateValue("JSON.stringify($(\"#main\").webAttention)");
  assert.equal(typeof json, "string");
  return JSON.parse(json as string) as WebAttention;
}

async function click(app: PagentApp, action: "continue" | "cancel"): Promise<void> {
  await app.browser.evaluateValue(`$(\"#main\").shadowRoot.querySelector('[data-web-${action}]').click()`);
}

async function settled(app: PagentApp): Promise<void> {
  await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").canSubmit && $(\"#main\").inputs.at(-1).submittedMessage === null");
  await app.flush();
}

for (const research of ["chromium", "firefox"] as const) {
  test(`${research} research uses real web tools with native intervention, resume, cancellation and isolation`, { timeout: 110_000 }, async t => {
    const workspace = research === "chromium" ? "firefox" : "chromium";
    const root = await mkdtemp(path.join(tmpdir(), "pagent-web-integration-"));
    const environment = { PI_WEB_BACKEND: process.env.PI_WEB_BACKEND, PI_WEB_BROWSER: process.env.PI_WEB_BROWSER,
      PI_BROWSER_HEADLESS: process.env.PI_BROWSER_HEADLESS, PI_WEB_PROFILE_DIR: process.env.PI_WEB_PROFILE_DIR };
    process.env.PI_WEB_BACKEND = "browser";
    process.env.PI_WEB_BROWSER = research;
    // Explicit host headless:true must override this environment value.
    process.env.PI_BROWSER_HEADLESS = "false";
    delete process.env.PI_WEB_PROFILE_DIR;
    const requests = new Map<string, number>();
    const server = createServer((request, response) => {
      const address = request.url ?? "/";
      requests.set(address, (requests.get(address) ?? 0) + 1);
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      if (address === "/frame") {
        response.end("<!doctype html><title>Foreign frame</title><script>parent.postMessage({probe:'foreign-frame',aos:typeof window.aos},'*')</script>");
        return;
      }
      response.end("<!doctype html><title>Captcha fixture</title><main><p>Please complete the following challenge to confirm you are human.</p><p>Test-only local challenge; no provider or search network request.</p></main>");
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const diagnostics: string[] = [];
    let app: PagentApp | undefined;
    const researchConnections: Cdp[] = [];
    try {
      app = await startPagent({ directory: root, port: 0, fake: true, headless: true, browser: workspace,
        noSandbox: workspace === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: message => diagnostics.push(message) });
      // Observe real launches/transports rather than substituting browser behavior.
      const launches: NativeBrowserProcess[] = [];
      const originalStart = BrowserProcessLauncher.prototype.start;
      t.mock.method(BrowserProcessLauncher.prototype, "start", async function (this: BrowserProcessLauncher) {
        const runtime = await originalStart.call(this);
        launches.push(runtime);
        return runtime;
      });
      const bidiConnections: Bidi[] = [];
      const originalBidiConnect = Bidi.connect;
      t.mock.method(Bidi, "connect", async (endpoint: string, timeout?: number) => {
        const connection = await originalBidiConnect(endpoint, timeout);
        bidiConnections.push(connection);
        return connection;
      });
      let cdp: Cdp | undefined;
      function disconnectResearch(): void { cdp?.close(); cdp = undefined; }
      async function evaluateResearch(tabId: string, expression: string): Promise<unknown> {
        const runtime = launches.at(-1);
        assert(runtime, "research created its own real browser process");
        assert.equal(runtime.kind, research, "explicit PI_WEB_BROWSER overrides the workspace engine");
        if (research === "firefox") {
          const bidi = bidiConnections.at(-1);
          assert(bidi);
          const result = await bidi.request("script.evaluate", { expression, target: { context: tabId }, awaitPromise: true, resultOwnership: "none" });
          assert.notEqual(result.type, "exception", JSON.stringify(result));
          return remoteValue(result.result);
        }
        if (!cdp || cdp.closed) {
          const endpoint = new URL(runtime.endpoint);
          const targets: unknown = await (await fetch(`http://${endpoint.host}/json/list`)).json();
          assert(Array.isArray(targets));
          const target = targets.map(object).find(target => target.id === tabId);
          assert.equal(typeof target?.webSocketDebuggerUrl, "string");
          cdp = await Cdp.connect(target!.webSocketDebuggerUrl as string);
          researchConnections.push(cdp);
        }
        const result = await cdp.request("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
        assert(!result.exceptionDetails, JSON.stringify(result));
        return object(result.result).value;
      }
      async function correct(tabId: string, text: string): Promise<void> {
        await evaluateResearch(tabId, `(() => {
          document.title = 'Local research article';
          document.body.innerHTML = '<main><h1>Verified local article</h1><p></p><research-code></research-code></main>';
          document.querySelector('p').textContent = ${JSON.stringify(text)};
          document.querySelector('research-code').attachShadow({mode:'open'}).innerHTML = '<pre><code>const verified = true;</code></pre>';
          window.humanCorrection = 'retained';
        })()`);
      }
      async function closeResearchTab(tabId: string): Promise<void> {
        if (research === "firefox") await bidiConnections.at(-1)!.request("browsingContext.close", { context: tabId });
        else {
          const connection = await Cdp.connect(launches.at(-1)!.endpoint);
          try { await connection.request("Target.closeTarget", { targetId: tabId }); }
          finally { connection.close(); }
        }
        disconnectResearch();
      }

      const firstUrl = `${origin}/first`;
      await submit(app, firstUrl);
      const first = await attention(app);
      assert.equal(first.url, firstUrl);
      assert.equal(await evaluateResearch(first.tabId, "typeof window.aos"), "undefined", "research never receives the workspace native bridge");
      assert.equal(await app.browser.evaluateValue("typeof aos.send"), "function");
      const researchProfile = path.join(app.stateDirectory, "research", createHash("sha256").update("main").digest("hex"), research);
      const owner = JSON.parse(await readFile(path.join(researchProfile, ".pi-browser-owner", "owner.json"), "utf8"));
      assert.equal(owner.browserPid, launches[0].child.pid);
      assert.equal(requests.get("/first"), 1);
      // Changing the backend only affects later invocations, including while attention is pending.
      await app.browser.evaluateValue(`(() => {
        const select = $(\"#main\").shadowRoot.querySelector('[data-web-backend]');
        select.value = 'codex'; select.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(app, "$(\"#main\").webBackend?.override === 'codex'");
      assert.equal((await attention(app)).id, first.id);
      assert.equal(launches.length, 1, "changing backend does not replace the active research process");
      assert.equal(app.agents.get("main")!.busy, true, "changing backend does not cancel inference or attention");

      // Reconnect through the real native channel while the tool waits. No navigation.
      await app.browser.evaluateValue(`(() => {
        window.interventionEvents = [];
        aos.addEventListener('event', ({detail}) => interventionEvents.push(detail.event.type));
        $(\"#main\").connected = false;
        $(\"#main\").webAttention = null;
        $(\"#main\").refresh();
        aos.send({type:'ready',agents:pagent.agents.map(a=>a.configuration),after:$(\"#main\").lastSeq});
      })()`);
      await waitFor(app, `$(\"#main\").connected && $(\"#main\").webAttention?.id === ${JSON.stringify(first.id)} && interventionEvents.includes('connected') && interventionEvents.includes('web-attention')`);
      assert.equal(requests.get("/first"), 1, "reconnection did not reload the research page");
      await waitFor(app, "$(\"#main\").webBackend?.override === 'codex'");
      await correct(first.tabId, "Human-corrected content survives Continue.");
      await click(app, "continue");
      await settled(app);
      assert.equal(await evaluateResearch(first.tabId, "window.humanCorrection"), "retained");
      assert.equal(requests.get("/first"), 1, "Continue inspected the same DOM without navigation");
      const history = validateHistory(await app.browser.evaluateValue("pagent.collectContext(\"main\").history"));
      const fetched = history.find(message => message.role === "toolResult" && message.toolName === "web_fetch");
      assert(fetched?.role === "toolResult");
      assert.equal(fetched.isError, false);
      assert.match(JSON.stringify(fetched.content), /Human-corrected content survives Continue/);
      assert.match(JSON.stringify(fetched.content), /const verified = true/);
      const final = history.at(-1);
      assert(final?.role === "assistant" && final.content[0]?.type === "text");
      const modelContext = JSON.parse(final.content[0].text) as { tools: { name: string }[] };
      assert.deepEqual(modelContext.tools.map(tool => tool.name), ["console", "save", "reload", "wait", "web_search", "web_fetch", "web_read"]);
      assert.equal(await app.browser.evaluateValue("$(\"#main\").webAttention"), null);
      assert.equal(await app.browser.evaluateValue("$(\"#main\").shadowRoot.querySelector('[data-web-progress]').hidden"), true);
      disconnectResearch();
      await app.browser.evaluateValue("aos.send({type:'backend-set',override:null})");
      await waitFor(app, "$(\"#main\").webBackend?.override === null && $(\"#main\").webBackend.effective === 'browser'");
      assert.equal(launches.length, 1, "resetting selection preserves the research process for reuse");

      const cancelledUrl = `${origin}/cancel`;
      await submit(app, cancelledUrl);
      const cancelled = await attention(app);
      await app.browser.evaluateValue(`aos.send({type:'web-continue',agentId:'main',id:${JSON.stringify(first.id)}})`);
      await waitFor(app, "$(\"#main\").state.notice.includes('no longer active')");
      assert.equal((await attention(app)).id, cancelled.id, "stale ID cannot settle the current wait");
      await click(app, "cancel");
      await settled(app);
      assert.equal(await evaluateResearch(cancelled.tabId, "document.title"), "Captcha fixture", "cancelling attention keeps the tab intact");
      await submit(app, cancelledUrl);
      const retried = await attention(app);
      assert.equal(retried.tabId, cancelled.tabId, "identical retry resumes the retained page");
      assert.notEqual(retried.id, cancelled.id, "each wait has fresh authority");
      assert.equal(requests.get("/cancel"), 1);
      await correct(retried.tabId, "Cancelled research resumed without navigation.");
      await click(app, "continue");
      await settled(app);
      assert.equal(requests.get("/cancel"), 1);
      disconnectResearch();

      await submit(app, `${origin}/failure`);
      const failed = await attention(app);
      await app.browser.evaluateValue(`(() => {
        window.unsavedWorkspaceRuntime = 'still-alive';
        const marker = document.createElement('p'); marker.id = 'unsaved-research-marker'; marker.textContent = 'Keep workspace DOM'; document.body.append(marker);
      })()`);
      await closeResearchTab(failed.tabId);
      await click(app, "continue");
      await settled(app);
      assert.equal(await app.browser.evaluateValue("window.unsavedWorkspaceRuntime"), "still-alive", "research failure never reset the workspace runtime");
      assert.equal(await app.browser.evaluateValue("document.querySelector('#unsaved-research-marker').textContent"), "Keep workspace DOM");
      const failureHistory = validateHistory(await app.browser.evaluateValue("pagent.collectContext(\"main\").history"));
      const lastFetch = failureHistory.findLast(message => message.role === "toolResult");
      assert(lastFetch?.role === "toolResult" && lastFetch.isError);
      assert.match(JSON.stringify(lastFetch.content), /closed|debugging connection failed/);
      assert.equal(await app.browser.evaluateValue("$(\"#main\").webAttention"), null);

      await app.browser.evaluateValue(`(() => {
        window.foreignFrameProbe = null;
        addEventListener('message', event => { if(event.data?.probe === 'foreign-frame') foreignFrameProbe = event.data.aos; });
        const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(`${origin}/frame`)}; document.body.append(frame);
      })()`);
      await waitFor(app, "foreignFrameProbe === 'undefined'");
      assert.equal(await app.browser.evaluateValue("typeof aos.send"), "function", "native capability remains workspace-main-frame only");
      assert.deepEqual(diagnostics, [], `unexpected host diagnostics: ${diagnostics.join("\n")}`);
    } finally {
      for (const connection of researchConnections) connection.close();
      await app?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      await rm(root, { recursive: true, force: true });
    }
  });
}
