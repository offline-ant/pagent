import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import { startServer } from "../src/server.ts";
import { openWorkspace } from "../src/storage.ts";
import type { AgentEvent, PageBrowser } from "../src/protocol.ts";

const assistant = (text: string, stopReason = "stop") => ({
  role: "assistant", content: [{ type: "text", text }], stopReason, timestamp: 123,
  opaqueProviderField: "provider-private",
});

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine}: public-html exposes only final prose through ordinary DOM and preserves history, ordering and identity`, { timeout: 70_000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), `pagent-public-html-${engine}-`));
    const workspace = await openWorkspace({ directory, templateDir: fileURLToPath(new URL("../template/", import.meta.url)) });
    await workspace.write("/index.html", Buffer.from(`<!doctype html><html><head><link rel="stylesheet" href="/agent.css"><script type="module" src="/agent.js"></script></head><body>
      <p-agent id="public" public-html persist-end="body"><p-agent id="nested"></p-agent></p-agent>
      <p-agent id="private"></p-agent>
    </body></html>`));
    const server = await startServer(workspace);
    let browser: PageBrowser | undefined;
    const requests: unknown[] = [];
    t.after(async () => {
      await browser?.close(); await server.close(); await workspace.close();
      await rm(directory, { recursive: true, force: true });
    });
    browser = await launchBrowser({ browser: engine, headless: true, profileDir: join(directory, "profile"),
      url: server.url, noSandbox: engine === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1",
      onRequest: request => { requests.push(request); },
    });
    const page = browser;
    const value = (expression: string) => page.evaluateValue(expression);
    const json = async (expression: string) => JSON.parse(String(await value(`JSON.stringify(${expression})`)));
    let seq = 0;
    let runId: string | undefined;
    let inputId: string | undefined;
    const emit = async (event: AgentEvent) => {
      const record = { seq: ++seq, agentId: "public", requestId: inputId, runId, event };
      await page.deliver(record);
      return record;
    };
    for (const id of ["public", "nested", "private"]) await page.deliver({ seq: ++seq, agentId: id,
      event: { type: "connected", url: server.url, model: "local/fixture", busy: false } });
    runId = String(await value(`$('#public').prompt('test')`));
    inputId = String(await value(`$('#public').run.inputId`));
    await value(`window.agent = $('#public'); window.output = agent.outputs[0]; window.root = agent.shadowRoot;
      window.clock = 1000; Date.now = () => clock;
      window.publicTexts = () => [...output.querySelectorAll('.paragraph-text')].map(node => node.textContent);
      window.displayedTexts = () => [...output.shadowRoot.querySelector('.paragraphs').children].map(node =>
        (node.localName === 'slot' ? node.assignedElements()[0] : node).querySelector('.paragraph-text').textContent);`);
    const user = await json("agent.inputs.find(input => input.submittedMessage).submittedMessage");
    const toolMessage = { ...assistant("Private tool commentary", "toolUse"), content: [
      { type: "thinking", thinking: "Private reasoning", thinkingSignature: "private-signature" },
      { type: "text", text: "Private tool commentary" },
      { type: "toolCall", id: "call-1", name: "console", arguments: { code: "privateToolCode" } },
    ] };
    const toolResult = { role: "toolResult", toolCallId: "call-1", toolName: "console", content: [{ type: "text", text: "Private tool result" }], timestamp: 124, isError: false };
    await emit({ type: "message", phase: "end", message: toolMessage });
    await emit({ type: "message", phase: "end", message: toolResult });
    await emit({ type: "message", phase: "update", message: assistant("First final paragraph\n\nUnfinished") });
    assert.deepEqual(await json("publicTexts()"), [], "even a completed streaming paragraph stays private until message completion");
    assert.match(String(await value("output.shadowRoot.querySelector('.response').textContent")), /First final paragraph/);
    const unsafe = "<img src=x onerror='window.pwned=true'><script>window.pwned=true</script>";
    const final = assistant(`First final paragraph\n\n${unsafe}`);
    await value("window.clock = 2000");
    const finalRecord = await emit({ type: "message", phase: "end", message: final });
    await emit({ type: "run", run: { id: runId, agentId: "public", inputId, status: "complete", result: "bounded result" } });
    assert.deepEqual(await json("publicTexts()"), [unsafe, "First final paragraph"]);
    assert.deepEqual(await json("displayedTexts()"), [unsafe, "First final paragraph", "Private tool commentary"]);
    assert.equal(await value("output.shadowRoot.querySelectorAll('.paragraph-text').length"), 1, "public prose is slotted, not displayed twice");
    assert.equal(await value("output.querySelectorAll('img,script').length"), 0, "public prose remains inert text");
    assert.equal(await value("Boolean(window.pwned)"), false);
    assert.match(String(await value("agent.outerHTML")), /First final paragraph/);
    assert.doesNotMatch(String(await value("agent.outerHTML")), /Private tool|Private reasoning|provider-private|private-signature|privateToolCode/);
    assert.match(String(await value("pagent.collectContext('private').outline")), /First final paragraph/);
    assert.doesNotMatch(String(await value("pagent.collectContext('private').outline")), /Private tool|provider-private/);
    const history = [user, toolMessage, toolResult, final];
    assert.deepEqual(await json("agent.messages"), history, "full provider history remains chronological and unchanged");
    assert.equal(await value("agent.run.id"), runId);
    assert.equal(await value("agent.result"), "bounded result");
    const timestamps = await json("[...output.querySelectorAll('time')].map(node => node.dateTime)");
    await value("window.savedBlock = output.querySelector('.paragraph'); output.persist()");
    assert.equal(await value("savedBlock === output.querySelector('.paragraph')"), true, "rerender preserves public paragraph identity");
    await page.deliver(finalRecord);
    assert.deepEqual(await json("agent.messages"), history, "replay does not duplicate public or private records");
    assert.deepEqual(await json("publicTexts()"), [unsafe, "First final paragraph"]);

    for (const id of ["private", "nested"]) {
      await value(`(() => { const a = $('#${id}'); const o = a.ensureTurn(a.inputs[0].id).output;
        o.apply(${JSON.stringify({ type: "message", phase: "end", message: assistant(`Hidden ${id}`) })}); })()`);
      assert.equal(await value(`$('#${id}').querySelectorAll('.paragraph-text').length`), 0, "nearest agent decides; public-html is not inherited by nested agents");
      assert.match(String(await value(`$('#${id}').outputs[0].shadowRoot.textContent`)), new RegExp(`Hidden ${id}`));
    }
    await value("agent.removeAttribute('public-html')");
    assert.equal(await value("agent.hasAttribute('public-html')"), true, "presentation setting is pinned while registered");

    // Existing public prose and full shadow state survive same-node persistence.
    const beforeRecovery = requests.length;
    await value("document.body.innerHTML = '<article>replacement page</article>'; new Promise(resolve => setTimeout(resolve, 0))");
    assert.equal(await value("$('#public') === agent && agent.shadowRoot === root && agent.outputs[0] === output"), true);
    assert.equal(requests.slice(beforeRecovery).some(request => (request as { type: string; agentId?: string }).type === "dispose" && (request as { agentId?: string }).agentId === "public"), false);
    assert.deepEqual(await json("publicTexts()"), [unsafe, "First final paragraph"]);
    assert.deepEqual(await json("agent.messages"), history);

    await workspace.write("/index.html", Buffer.from(await page.snapshot()));
    await page.reload();
    await value(`window.agent = $('#public'); window.output = agent.outputs[0];
      window.publicTexts = () => [...output.querySelectorAll('.paragraph-text')].map(node => node.textContent);`);
    assert.deepEqual(await json("publicTexts()"), [unsafe, "First final paragraph"], "saved light DOM restores without duplicates");
    assert.deepEqual(await json("[...output.querySelectorAll('time')].map(node => node.dateTime)"), timestamps);
    assert.deepEqual(await json("agent.messages"), history);
    assert.equal(await value("agent.run.id"), runId);

    // Editable canonical records determine publication; error/aborted/length and
    // contradictory tool-bearing messages never become public final answers.
    for (const reason of ["error", "aborted", "length", "toolUse"]) {
      await value(`output.apply(${JSON.stringify({ type: "message", phase: "end", message: assistant(`Not final ${reason}`, reason) })})`);
    }
    await value(`output.apply(${JSON.stringify({ type: "message", phase: "end", message: { ...toolMessage, stopReason: "stop" } })})`);
    assert.deepEqual(await json("publicTexts()"), [unsafe, "First final paragraph"]);
    await value("output.state.messages[2].content[0].text = 'Edited final'; output.persist()");
    assert.deepEqual(await json("publicTexts()"), ["Edited final"]);
    assert.match(String(await value("pagent.collectContext('public').outline")), /Edited final/);
    await value("output.state.messages[2].stopReason = 'error'; output.persist()");
    assert.deepEqual(await json("publicTexts()"), [], "changing canonical eligibility removes public prose");
    assert.equal(await value("output.shadowRoot.querySelector('.paragraphs').textContent.includes('Edited final')"), true);
    await value("output.state.messages = []; output.state.partial = null; output.persist()");
    assert.equal(await value("output.querySelectorAll('[data-pagent-public-paragraph]').length"), 0);
    assert.equal(await value("output.shadowRoot.querySelector('.paragraphs').children.length"), 0);
  });
}
