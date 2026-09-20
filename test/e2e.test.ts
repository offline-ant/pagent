import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { startPagent, type PagentApp } from "../src/app.ts";
import { validateHistory } from "../src/agent.ts";

async function waitFor(app: PagentApp, expression: string, timeoutMs = 25_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try { if (await app.browser.evaluateValue(expression) === true) return; }
    catch (error) { last = error; }
    await delay(25);
  }
  throw new Error(`Timed out: ${expression}\n${String(last)}`);
}

async function submit(app: PagentApp, text: string): Promise<void> {
  const result = await app.browser.evaluateValue(`(() => {
    const input = $(\"#main\").inputs.at(-1);
    input.value = ${JSON.stringify(text)};
    return typeof $(\"#main\").submit(input.id) === "string";
  })()`);
  assert.equal(result, true);
}

for (const browser of ["chromium", "firefox"] as const) {
test(`${browser} complete VM: Pi tool loop, reload/replay, page history, editable source, cancel and resume`, { timeout: 100_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pagent-e2e-"));
  const logs: string[] = [];
  let app: PagentApp | undefined;
  const options = { directory: root, port: 0, headless: true, fake: true, browser,
    noSandbox: browser === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1", log: (line: string) => logs.push(line) };
  try {
    app = await startPagent(options);
    assert.match(app.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.equal(await app.browser.evaluateValue("$(\"#main\").canSubmit"), true);
    await submit(app, "Build something in this page");
    await waitFor(app, `!$(\"#main\").state.busy && $(\"#main\").outputs[0]?.messages.some(m => m.role === 'assistant' && m.content.some(c => c.type === 'text' && c.text.startsWith('Pagent smoke complete.')))`);
    await app.save();
    await app.flush();
    const history = await app.browser.evaluateValue("pagent.collectContext(\"main\", $(\"#main\").inputs.at(-1).id).history");
    const valid = validateHistory(history);
    assert.equal(valid.length, 8, "all user, assistant, and tool-result records survived a mid-turn reload");
    assert.deepEqual(valid.filter(message => message.role === "toolResult").map(message => [message.toolName, message.isError]), [["console", false], ["save", false], ["reload", false]]);
    assert.equal(await app.browser.evaluateValue("typeof pagentSmoke"), "undefined", "reload resets scratch variables");
    assert.equal(await app.browser.evaluateValue("document.querySelector('#pagent-smoke').textContent"), "The agent changed this live document.");
    assert.match(await readFile(path.join(app.directory, "info.html"), "utf8"), /Persistent knowledge/);
    const saved = await readFile(path.join(app.directory, "index.html"), "utf8");
    assert.match(saved, /shadowrootserializable/);
    assert.match(saved, /Pagent smoke complete/);
    assert.match(saved, /local scripted smoke test/);

    // A second submission must consume the page's records, not an unrelated hidden session.
    await submit(app, "/fake-inspect");
    await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").outputs.length === 2 && $(\"#main\").outputs[1].messages.length === 1");
    const inspectText = await app.browser.evaluateValue("$(\"#main\").outputs[1].messages[0].content.find(c => c.type === 'text').text");
    assert.equal(typeof inspectText, "string");
    const inspected = JSON.parse(inspectText as string) as { systemPrompt: string; messages: Array<{ role: string; content: unknown }>; tools: Array<{ name: string }> };
    assert(inspected.messages.length >= 10, "history + current user + current memory are present");
    assert.deepEqual(inspected.tools.map(tool => tool.name), ["console", "save", "reload", "wait", "web_search", "web_fetch", "web_read"]);
    assert(!inspected.systemPrompt.includes("Current working directory"));
    assert(!inspected.systemPrompt.includes("Workspace Guide"));
    assert.match(inspected.systemPrompt, browser === "firefox" ? /Firefox console accepts Promise expressions/ : /Chromium console supports REPL top-level await/);

    // The application source is an ordinary editable resource, not a shared host bundle.
    const edited = await app.browser.evaluate(`(async () => {
      const source = await (await fetch('/agent.js')).text();
      const response = await fetch('/agent.js', {method:'POST', headers:{'Content-Type':'text/javascript'}, body:source + '\\nglobalThis.customUI = "session-owned";\\n'});
      return response.status;
    })()`);
    assert.equal(edited.value, 204);
    await app.save();
    await app.browser.reload();
    assert.equal(await app.browser.evaluateValue("customUI"), "session-owned");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs.length"), 2);

    await submit(app, "/fake-wait");
    await waitFor(app, "$(\"#main\").state.busy");
    // Give the in-memory SDK session time to enter its cancellable provider wait.
    await delay(100);
    await app.browser.evaluateValue("aos.send({type:'cancel',agentId:'main'})");
    await waitFor(app, "!$(\"#main\").state.busy && $(\"#main\").canSubmit");
    await app.browser.evaluateValue("$(\"#main\").inputs.at(-1).value = 'An unsent draft survives restart'");
    await app.save();
    const before = await app.browser.evaluateValue("$(\"#main\").outputs.length");
    const png = await app.browser.screenshot();
    if (process.env.PAGENT_SCREENSHOT) await writeFile(process.env.PAGENT_SCREENSHOT, Buffer.from(png, "base64"));
    await app.close();
    app = await startPagent(options);
    assert.equal(await app.browser.evaluateValue("customUI"), "session-owned", "startup never overwrites edited template files");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").inputs.at(-1).value"), "An unsent draft survives restart");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").outputs.length"), before, "resume never resubmits old prompts");
    assert.equal(await app.browser.evaluateValue("$(\"#main\").canSubmit"), true);
    await app.flush();
    assert.deepEqual(logs, [], `unexpected host errors: ${logs.join("\n")}`);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
}

test("a saved workspace can move from Chromium to Firefox and back without reseeding", { timeout: 45_000 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'pagent-engine-switch-'));
  const options = { directory: root, port: 0, headless: true, fake: true };
  let app: PagentApp | undefined;
  try {
    app = await startPagent({ ...options, browser: 'chromium', noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === '1' });
    await app.browser.evaluateValue(`(() => {
      document.querySelector('agent-memory').textContent = 'Cross-engine memory';
      $(\"#main\").inputs[0].value = 'Cross-engine draft';
    })()`);
    await app.save();
    await app.close();
    app = await startPagent({ ...options, browser: 'firefox' });
    assert.equal(await app.browser.evaluateValue("document.querySelector('agent-memory').textContent"), 'Cross-engine memory');
    assert.equal(await app.browser.evaluateValue('$(\"#main\").inputs[0].value'), 'Cross-engine draft');
    await submit(app, '/fake-inspect');
    await waitFor(app, '$(\"#main\").canSubmit && $(\"#main\").outputs[0]?.messages.length === 1');
    await app.close();
    app = await startPagent({ ...options, browser: 'chromium', noSandbox: process.env.PAGENT_TEST_NO_SANDBOX === '1' });
    assert.equal(await app.browser.evaluateValue('$(\"#main\").outputs[0].messages.length'), 1);
    assert.equal(await app.browser.evaluateValue("document.querySelector('agent-memory').textContent"), 'Cross-engine memory');
    assert.equal(validateHistory(await app.browser.evaluateValue('pagent.collectContext(\"main\").history')).length, 2);
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
