import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import type { WebAttention } from "pi-browser/web";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";
import { brokerExit, isolateBrokers, ResearchObserver, researchProfile } from "./research.ts";

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
  test(`${research} research uses real web tools with native intervention, resume, cancellation and isolation`, { timeout: 110_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pagent-web-integration-"));
    const restoreTmpdir = isolateBrokers(root);
    const environment = { PI_WEB_BACKEND: process.env.PI_WEB_BACKEND, PI_BROWSER_HEADLESS: process.env.PI_BROWSER_HEADLESS };
    process.env.PI_WEB_BACKEND = "browser";
    // Explicit host headless:true must override this environment value.
    process.env.PI_BROWSER_HEADLESS = "false";
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
    let observer: ResearchObserver | undefined;
    try {
      app = await startPagent({ directory: root, port: 0, fake: true, headless: true, browser: research,
        noSandbox: research === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: message => diagnostics.push(message) });
      const stateDirectory = app.stateDirectory;
      const evaluateResearch = (tab: string, expression: string) => {
        observer ??= new ResearchObserver(stateDirectory, "main", research);
        return observer.evaluate(tab, expression);
      };
      async function correct(tab: string, text: string): Promise<void> {
        await evaluateResearch(tab, `(() => {
          document.title = 'Local research article';
          document.body.innerHTML = '<main><h1>Verified local article</h1><p></p><research-code></research-code></main>';
          document.querySelector('p').textContent = ${JSON.stringify(text)};
          document.querySelector('research-code').attachShadow({mode:'open'}).innerHTML = '<pre><code>const verified = true;</code></pre>';
          window.humanCorrection = 'retained';
        })()`);
      }

      const firstUrl = `${origin}/first`;
      await submit(app, firstUrl);
      const first = await attention(app);
      assert.equal(first.url, firstUrl);
      assert.equal(first.tab, `127.0.0.1:${address.port}+5`, "research tabs are named after their URL");
      assert.equal(await evaluateResearch(first.tab, "typeof window.aos"), "undefined", "research never receives the workspace native bridge");
      assert.equal(await app.browser.evaluateValue("typeof aos.send"), "function");
      const ownerFile = path.join(researchProfile(app.stateDirectory, "main", research), ".pi-browser-owner", "owner.json");
      const owner = JSON.parse(await readFile(ownerFile, "utf8"));
      assert.equal(owner.browser, research, "research follows the workspace engine in the agent's own profile");
      const researchPid = async () => JSON.parse(await readFile(ownerFile, "utf8")).browserPid;
      assert.equal(requests.get("/first"), 1);
      // Changing the backend only affects later invocations, including while attention is pending.
      await app.browser.evaluateValue(`(() => {
        const select = $(\"#main\").shadowRoot.querySelector('[data-web-backend]');
        select.value = 'codex'; select.dispatchEvent(new Event('change'));
      })()`);
      await waitFor(app, "$(\"#main\").webBackend?.override === 'codex'");
      assert.equal((await attention(app)).id, first.id);
      assert.equal(await researchPid(), owner.browserPid, "changing backend does not replace the active research process");
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
      await correct(first.tab, "Human-corrected content survives Continue.");
      await click(app, "continue");
      await settled(app);
      assert.equal(await evaluateResearch(first.tab, "window.humanCorrection"), "retained");
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
      await app.browser.evaluateValue("aos.send({type:'backend-set',override:null})");
      await waitFor(app, "$(\"#main\").webBackend?.override === null && $(\"#main\").webBackend.effective === 'browser'");
      assert.equal(await researchPid(), owner.browserPid, "resetting selection preserves the research process for reuse");

      const cancelledUrl = `${origin}/cancel`;
      await submit(app, cancelledUrl);
      const cancelled = await attention(app);
      await app.browser.evaluateValue(`aos.send({type:'web-continue',agentId:'main',id:${JSON.stringify(first.id)}})`);
      await waitFor(app, "$(\"#main\").state.notice.includes('no longer active')");
      assert.equal((await attention(app)).id, cancelled.id, "stale ID cannot settle the current wait");
      await click(app, "cancel");
      await settled(app);
      assert.equal(await evaluateResearch(cancelled.tab, "document.title"), "Captcha fixture", "cancelling attention keeps the tab intact");
      await submit(app, cancelledUrl);
      const retried = await attention(app);
      assert.equal(retried.tab, cancelled.tab, "identical retry resumes the retained page");
      assert.notEqual(retried.id, cancelled.id, "each wait has fresh authority");
      assert.equal(requests.get("/cancel"), 1);
      await correct(retried.tab, "Cancelled research resumed without navigation.");
      await click(app, "continue");
      await settled(app);
      assert.equal(requests.get("/cancel"), 1);

      await submit(app, `${origin}/failure`);
      const failed = await attention(app);
      await app.browser.evaluateValue(`(() => {
        window.unsavedWorkspaceRuntime = 'still-alive';
        const marker = document.createElement('p'); marker.id = 'unsaved-research-marker'; marker.textContent = 'Keep workspace DOM'; document.body.append(marker);
      })()`);
      await observer!.closeTab(failed.tab);
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
      const brokersExited = await brokerExit(root);
      await observer?.close();
      await app?.close();
      await brokersExited();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      for (const [key, value] of Object.entries(environment)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      restoreTmpdir();
      await rm(root, { recursive: true, force: true });
    }
  });
}
