import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import type { AgentEvent, HostEvent, PageBrowser } from "../src/protocol.ts";

const templateDir = fileURLToPath(new URL("../template/", import.meta.url));
const textPart = (text: string) => ({ type: "text", text });
const assistant = (text: string, timestamp = 123) => ({ role: "assistant", content: [textPart(text)], timestamp });

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine}: completed paragraphs are newest-first without changing conversation records`, { timeout: 70_000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), `pagent-paragraphs-${engine}-`));
    let html = await readFile(path.join(templateDir, "index.html"), "utf8");
    const server = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      try {
        const resource = request.url?.slice(1) ?? "";
        if (["agent.js", "agent-connection.js", "agent-controls.js", "p-agent.js", "user-input.js", "agent-output.js", "dom.js", "paragraphs.js", "agent.css"].includes(resource)) {
          response.setHeader("Content-Type", resource.endsWith(".js") ? "text/javascript" : "text/css");
          response.end(await readFile(path.join(templateDir, resource)));
        } else {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        }
      } catch (error) { response.writeHead(500).end(String(error)); }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert(address && typeof address !== "string");
    let page: PageBrowser | undefined;
    t.after(async () => {
      await page?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    page = await launchBrowser({
      browser: engine, profileDir: directory, headless: true,
      noSandbox: engine === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1",
      url: `http://127.0.0.1:${address.port}/`, onRequest: () => {},
    });
    const browser = page;
    const value = (expression: string) => browser.evaluateValue(expression);
    const json = async (expression: string) => JSON.parse(String(await value(`JSON.stringify(${expression})`)));
    let seq = 0;
    let lastRecord: HostEvent;
    let runId: string | undefined;
    const emit = async (event: AgentEvent) => {
      lastRecord = { seq: ++seq, agentId: "main", requestId: "prompt-0", runId, event };
      await browser.deliver(lastRecord);
    };
    const message = (text: string, phase: "update" | "end" = "update") => emit({ type: "message", phase, message: assistant(text) });
    const setup = () => value(`(() => {
      window.output = $(\"#main\").outputs[0];
      window.clock = 1000; Date.now = () => window.clock;
      window.paragraphTexts = () => output.paragraphs.map(item => item.text);
      window.visibleTexts = () => [...output.shadowRoot.querySelectorAll('.paragraph-text')].map(node => node.textContent);
    })()`);
    await emit({ type: "connected", url: `http://127.0.0.1:${address.port}/`, model: "local/fixture", busy: false });
    runId = String(await value(`$('#main').inputs[0].value = "test"; $('#main').submit("prompt-0")`));
    const user = { role: "user", content: [textPart("test")], timestamp: 1 };
    await emit({ type: "message", phase: "end", message: user });
    await setup();
    assert.equal(await value("output.shadowRoot.querySelector('.paragraph-loading').hidden"), false, "loading circle appears before the first paragraph");
    assert.equal(await value("getComputedStyle(output.shadowRoot.querySelector('.paragraph-loading')).animationName"), "paragraph-spin");
    await value("window.loadingCircle = output.shadowRoot.querySelector('.paragraph-loading')");

    await message("First line\nsecond line");
    assert.deepEqual(await json("visibleTexts()"), [], "unfinished tail is not displayed");
    assert.equal(await value("loadingCircle === output.shadowRoot.querySelector('.paragraph-loading') && !loadingCircle.hidden"), true, "streaming retains the same animated circle");
    await message("First line\nsecond line\n");
    assert.deepEqual(await json("visibleTexts()"), [], "one newline does not complete a paragraph");
    await message("First line\nsecond line\n\nunfinished");
    assert.deepEqual(await json("visibleTexts()"), ["First line\nsecond line"]);
    assert.equal(await value("output.paragraphs[0].timestamp"), 1000);
    await value(`(() => {
      window.firstBlock = output.shadowRoot.querySelector('.paragraph');
      window.firstText = firstBlock.querySelector('.paragraph-text').firstChild;
      const range = document.createRange(); range.selectNodeContents(firstText);
      window.paragraphSelection = output.shadowRoot.getSelection?.() ?? window.getSelection();
      paragraphSelection.removeAllRanges(); paragraphSelection.addRange(range);
    })()`);
    await message("First line\nsecond line\n\nunfinished tail grows");
    assert.equal(await value("firstBlock === output.shadowRoot.querySelector('.paragraph') && firstText === firstBlock.querySelector('.paragraph-text').firstChild"), true, "unfinished streaming tails leave completed DOM untouched");
    await value("window.clock = 2000");
    await message("First line\nsecond line\n\nSecond\n \t\nlast");
    assert.deepEqual(await json("visibleTexts()"), ["Second", "First line\nsecond line"]);
    assert.deepEqual(await json("output.paragraphs.map(item => item.timestamp)"), [2000, 1000]);
    assert.equal(await value("firstBlock === output.shadowRoot.querySelectorAll('.paragraph')[1] && firstText === firstBlock.querySelector('.paragraph-text').firstChild"), true, "prepending completions preserves existing paragraph and text nodes");
    assert.equal(await value("paragraphSelection.toString()"), "First line\nsecond line", "streaming preserves the reader's selection");

    // A checkpoint taken while a tail is hidden must not expose or retimestamp it.
    const partialParagraphs = await json("output.paragraphs");
    html = await browser.snapshot();
    await browser.reload();
    await setup();
    assert.deepEqual(await json("output.paragraphs"), partialParagraphs);
    assert.deepEqual(await json("visibleTexts()"), ["Second", "First line\nsecond line"]);
    await browser.deliver(lastRecord!);
    assert.deepEqual(await json("output.paragraphs"), partialParagraphs, "replayed update is ignored by the persisted event cursor");
    await value("window.clock = 3000");
    const first = assistant("First line\nsecond line\n\nSecond\n \t\nlast");
    await emit({ type: "message", phase: "end", message: first });
    assert.deepEqual(await json("visibleTexts()"), ["last", "Second", "First line\nsecond line"]);
    assert.deepEqual(await json("output.paragraphs.map(item => item.timestamp)"), [3000, 2000, 1000]);

    const fenced = "```js\nconst a = 1;\n\nconst b = 2;\n```";
    await value("window.clock = 4000");
    await message("Before\n\n```js\nconst a = 1;\n\n");
    assert.deepEqual(await json("visibleTexts().slice(0, 2)"), ["Before", "last"], "blank lines inside open fences do not expose code");
    await message(`Before\n\n${fenced}\n`);
    assert.equal(await value("output.paragraphs[0].text"), "Before", "closed fence without a blank line still waits");
    await value("window.clock = 5000");
    await message(`Before\n\n${fenced}\n\nAfter`);
    assert.equal(await value("output.paragraphs[0].text"), fenced, "complete fence stays one plain-text block");
    const second = assistant(`Before\n\n${fenced}\n\nAfter`);
    await emit({ type: "message", phase: "end", message: second });

    const unsafe = "<img src=x onerror='window.pwned=true'><script>window.pwned=true</script>";
    const multipart = { role: "assistant", timestamp: 125, stopReason: "toolUse", opaque: { untouched: true }, content: [
      { type: "thinking", thinking: "Reasoning stays available", signature: "opaque-signature" },
      textPart("Part one\n\npart one tail"),
      { type: "toolCall", id: "call-1", name: "console", arguments: { code: "1 + 1" } },
      textPart(`${unsafe}\n\npart two tail`),
    ] };
    await emit({ type: "message", phase: "update", message: multipart });
    assert.deepEqual(await json("visibleTexts().slice(0, 3)"), [unsafe, "Part one", "After"], "newest-first spans parts and messages");
    await value(`output.shadowRoot.querySelector('.reasoning').open = true; output.shadowRoot.querySelector('.tool').open = true`);
    await emit({ type: "tool", phase: "end", callId: "call-1", name: "console", result: { answer: 2 }, isError: true });
    assert.equal(await value(`output.shadowRoot.querySelector('.reasoning').open && output.shadowRoot.querySelector('.tool').open`), true);
    await emit({ type: "message", phase: "end", message: multipart });
    assert.deepEqual(await json("visibleTexts().slice(0, 4)"), ["part two tail", unsafe, "part one tail", "Part one"]);
    const result = { role: "toolResult", toolCallId: "call-1", toolName: "console", content: [textPart("Tool result retained")], isError: true, timestamp: 126 };
    await emit({ type: "message", phase: "end", message: result });
    const failed = { ...assistant("Final failed tail", 127), errorMessage: "Provider failure", stopReason: "error" };
    await emit({ type: "message", phase: "end", message: failed });
    await emit({ type: "error", message: "Transport failure" });
    await emit({ type: "status", status: "idle" });
    assert.equal(await value("$('#main').state.busy"), true, "errors and SDK idle do not finish a run");
    await emit({ type: "run", run: { id: runId, agentId: "main", inputId: "prompt-0", status: "error", result: "", error: "Transport failure" } });
    assert.equal(await value("output.shadowRoot.querySelector('.paragraph-loading').hidden"), true, "settled output hides the circle");
    assert.equal(await value("getComputedStyle(output.shadowRoot.querySelector('.paragraph-loading')).display"), "none");
    const history = [user, first, second, multipart, result, failed];
    assert.deepEqual(await json("pagent.collectContext(\"main\").history"), history, "provider records retain exact chronological content and metadata");
    assert.deepEqual(await json("visibleTexts()"), await json("paragraphTexts()"));
    assert.equal(await value(`output.shadowRoot.querySelectorAll('.paragraph-text img, .paragraph-text script').length`), 0);
    assert.equal(await value("Boolean(window.pwned)"), false);
    assert.equal(await value(`output.shadowRoot.querySelectorAll('.tool').length`), 1, "tool events and message calls do not duplicate tools");
    assert.equal(await value(`['Reasoning stays available', 'Tool result retained', 'Provider failure', 'Transport failure', '1 + 1'].every(text => output.shadowRoot.querySelector('.response').textContent.includes(text))`), true);
    assert.equal(await value(`output.shadowRoot.querySelectorAll('.message .prose').length`), 1, "only reasoning uses the old prose renderer; assistant text is not duplicated");
    assert.equal(await value(`output.shadowRoot.querySelectorAll('time.paragraph-time[datetime]').length === output.paragraphs.length`), true);
    assert.equal(await value(`(() => { const copy = output.paragraphs; copy[0].text = 'edited'; copy.pop(); return output.paragraphs[0].text === 'Final failed tail'; })()`), true, "paragraph getter returns independent newest-first copies");

    const completed = await json("output.paragraphs");
    const tools = await json("output.tools");
    html = await browser.snapshot();
    await browser.reload();
    await setup();
    assert.deepEqual(await json("output.paragraphs"), completed, "HTML reload keeps first-completion timestamps");
    assert.equal(await value("output.shadowRoot.querySelector('.paragraph-loading').hidden"), true, "completed reload never shows a stale spinner");
    await browser.deliver(lastRecord!);
    assert.deepEqual(await json("output.paragraphs"), completed, "replay does not duplicate paragraphs");
    assert.deepEqual(await json("pagent.collectContext(\"main\").history"), history);
    assert.deepEqual(await json("output.tools"), tools);
    // String content, CRLF, tilde fences and unclosed final fences stay plain text.
    const special = { role: "assistant", content: "\r\nline 1\r\nline 2\r\n\t\r\n~~~txt\r\na\r\n\r\nb\r\n~~~\r\n\r\n```\nunclosed\n\ncode", timestamp: 200 };
    // This section edits the renderer directly: a terminal run correctly rejects late transport output.
    await value(`output.apply(${JSON.stringify({ type: "message", phase: "update", message: special })})`);
    assert.deepEqual(await json("visibleTexts().slice(0, 2)"), ["~~~txt\r\na\r\n\r\nb\r\n~~~", "line 1\r\nline 2"]);
    await value(`output.apply(${JSON.stringify({ type: "message", phase: "end", message: special })})`);
    assert.equal(await value("output.paragraphs[0].text"), "```\nunclosed\n\ncode", "message end flushes even an unclosed fence");
    await value(`output.apply(${JSON.stringify({ type: "message", phase: "end", message: assistant(" \n\n\t") })})`);
    assert.equal(await value("output.paragraphs[0].text"), "```\nunclosed\n\ncode", "whitespace-only completed content adds no empty paragraph");

    // Editable page records, not cached paragraphs, remain the source of truth.
    const editedMessages = await json("output.messages");
    const unchanged = await json("output.paragraphs.filter(item => item.messageIndex === 0)");
    const editedTimestamp = await value("output.paragraphs.find(item => item.messageIndex === 2 && item.partIndex === 1 && item.paragraphIndex === 0).timestamp");
    const unchangedTail = await value("output.paragraphs.find(item => item.messageIndex === 2 && item.partIndex === 1 && item.paragraphIndex === 1).timestamp");
    editedMessages[2].content[1].text = "Edited part one\n\npart one tail";
    await value(`window.clock = 9000; output.state.messages[2].content[1].text = 'Edited part one\\n\\npart one tail'; output.persist()`);
    assert.deepEqual(await json("output.messages"), editedMessages, "persist retains edited provider records including opaque metadata");
    assert.deepEqual(await json("pagent.collectContext(\"main\").history"), [user, ...editedMessages]);
    assert.equal(await value("visibleTexts().includes('Edited part one') && !visibleTexts().includes('Part one')"), true);
    assert.deepEqual(await json("output.paragraphs.filter(item => item.messageIndex === 0)"), unchanged, "unchanged positions retain first-completion timestamps");
    assert.equal(await value("output.paragraphs.find(item => item.messageIndex === 2 && item.partIndex === 1 && item.paragraphIndex === 1).timestamp"), unchangedTail, "editing one paragraph does not retimestamp its unchanged sibling");
    assert.equal(await value("output.paragraphs.find(item => item.text === 'Edited part one').timestamp"), editedTimestamp, "editing text at an existing position retains its first-completion time");

    editedMessages.splice(1, 1);
    await value("window.clock = 10000; output.state.messages.splice(1, 1); output.persist()");
    assert.deepEqual(await json("output.messages"), editedMessages, "removing stored messages does not rewrite the remaining provider content");
    assert.deepEqual(await json("visibleTexts()"), [
      "```\nunclosed\n\ncode", "~~~txt\r\na\r\n\r\nb\r\n~~~", "line 1\r\nline 2",
      "Final failed tail", "part two tail", unsafe, "part one tail", "Edited part one",
      "last", "Second", "First line\nsecond line",
    ], "removed messages disappear and remaining paragraphs follow current message order");
    assert.deepEqual(await json("output.paragraphs.filter(item => item.messageIndex === 0)"), unchanged);
    const reconciled = await json("output.paragraphs");
    await value("window.clock = 11000; output.persist()");
    assert.deepEqual(await json("output.paragraphs"), reconciled, "repeated persist never recreates completion times");
    await value("output.state.messages = []; output.state.partial = null; output.persist()");
    assert.deepEqual(await json("visibleTexts()"), [], "clearing history removes every cached paragraph");
    assert.deepEqual(await json("output.paragraphs"), []);
    await value("output.apply({type:'status',status:'running'}); $('#main').finish({...$('#main').run, status:'cancelled'})");
    assert.equal(await value("output.shadowRoot.querySelector('.paragraph-loading').hidden"), true, "interrupted output hides the circle");
  });
}
