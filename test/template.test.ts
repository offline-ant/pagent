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
const files = ["agent.js", "agent-persistence.js", "agent-connection.js", "agent-controls.js", "p-agent.js", "user-input.js", "agent-output.js", "dom.js", "paragraphs.js", "agent.css"];

for (const engine of ["chromium", "firefox"] as const) {
  test(`${engine}: independent page agents preserve append-only conversations, drafts, controls and replay`, { timeout: 70_000 }, async t => {
    const directory = await mkdtemp(path.join(tmpdir(), `pagent-template-${engine}-`));
    let html = await readFile(path.join(templateDir, "index.html"), "utf8");
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer(async (request, response) => {
      response.setHeader("Cache-Control", "no-store");
      const resource = request.url?.slice(1) ?? "";
      try {
        if (files.includes(resource)) {
          response.setHeader("Content-Type", resource.endsWith(".js") ? "text/javascript" : "text/css");
          response.end(await readFile(path.join(templateDir, resource)));
        } else {
          response.setHeader("Content-Type", "text/html; charset=utf-8");
          response.end(html);
        }
      } catch (error) { response.writeHead(500).end(String(error)); }
    });
    let browser: PageBrowser | undefined;
    t.after(async () => {
      await browser?.close();
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const url = `http://127.0.0.1:${address.port}/`;
    browser = await launchBrowser({ browser: engine, profileDir: directory, headless: true,
      noSandbox: engine === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1",
      url, onRequest: request => { requests.push(request as Record<string, unknown>); } });
    const page = browser;
    const value = (code: string) => page.evaluateValue(code);
    const json = async (code: string) => JSON.parse(String(await value(`JSON.stringify(${code})`)));
    let seq = 0;
    const emit = (event: unknown, agentId?: string, requestId?: string, runId?: string) => page.deliver({ seq: ++seq, event: event as AgentEvent, agentId, requestId, runId });
    const connected = (agentId: string, busy = false, run?: unknown) => emit({ type: "connected", url, model: "fake/model", busy, run }, agentId);
    const setup = () => value(`window.$ = document.querySelector.bind(document); window.main = $('#main');`);
    await setup();
    assert.deepEqual(requests.slice(), [{ type: "ready", after: 0, agents: [{ agentId: "main" }] }], "initial element upgrade only sends ready, never redundant registration or inference");
    assert.equal(await value("main.shadowRoot.serializable && main.inputs[0].shadowRoot.serializable"), true);
    assert.equal(await value("'thread' in pagent || 'submit' in pagent"), false, "no privileged first-agent API");
    assert.equal(await value("main.canSubmit"), false);
    const beforeDisconnectedControls = requests.length;
    await value("main.shadowRoot.querySelector('[data-save]').click(); main.shadowRoot.querySelector('[data-reload]').click()");
    assert.equal(requests.length, beforeDisconnectedControls, "disconnected workspace controls never send requests");
    const backendOptions = [["", "Use default"], ["auto", "Auto"], ["codex", "Codex"], ["browser", "Browser"]];
    assert.deepEqual(await json("[...main.shadowRoot.querySelector('[data-web-backend]').options].map(option => [option.value, option.textContent])"), backendOptions);
    await connected("main");
    await emit({ type: "workspace-state", busy: false });
    await emit({ type: "backend-state", state: { configured: "browser", override: null, effective: "browser", source: "environment" } });
    assert.equal(await value("main.canSubmit"), true);

    // A receiver or persistence failure must leave the replay cursor untouched.
    const retry: HostEvent = { seq: ++seq, agentId: "main", event: { type: "saved", revision: "retry-checkpoint" } };
    await value("window.originalReceive = main.receive; main.receive = () => { throw new Error('broken receiver'); };");
    await assert.rejects(page.deliver(retry), /did not acknowledge/);
    assert.equal(await value("main.lastSeq"), seq - 1);
    await value("main.receive = originalReceive; window.originalRefresh = main.refresh; main.refresh = () => { throw new Error('broken UI persistence'); };");
    await assert.rejects(page.deliver(retry), /did not acknowledge/);
    assert.equal(await value("main.lastSeq"), seq - 1);
    await value("main.refresh = originalRefresh");
    await page.deliver(retry);
    assert.equal(await value("main.lastSeq"), seq);
    assert.match(await page.snapshot(), /retry-checkpoint/);
    await value("main.receive = () => { throw new Error('duplicate must not reach receiver'); }");
    await page.deliver(retry);
    await value("main.receive = originalReceive");
    for (const invalid of [{ seq: -1, event: retry.event }, { seq: seq + 1 }, { seq: seq + 1, event: {} }]) {
      assert.equal(await value(`(() => {
        let acknowledged = false;
        const event = new CustomEvent('event', { detail: ${JSON.stringify(invalid)} });
        event.ack = () => { acknowledged = true; };
        aos.dispatchEvent(event);
        return acknowledged;
      })()`), false, "invalid native records must not be acknowledged");
      assert.equal(await value("main.lastSeq"), seq);
    }
    assert.equal(requests.filter(request => request.type === "submit").length, 0, "delivery, retries and failures never submit inference");

    const runId = String(await value("main.inputs[0].value = '<script>window.pwned=true</script>'; main.submit('prompt-0')"));
    assert.deepEqual(requests.at(-1), { type: "submit", agentId: "main", id: "prompt-0", runId });
    assert.equal(await value("main.status"), "running");
    assert.equal(await value("(() => { try { main.prompt('busy'); return false; } catch (error) { return error.message.includes('busy'); } })()"), true);
    const user = { role: "user", content: [{ type: "text", text: "<script>window.pwned=true</script>" }], timestamp: 1 };
    const assistant = { role: "assistant", content: [
      { type: "thinking", thinking: "Inspect the document first.", signature: "opaque-provider-field" },
      { type: "text", text: "<img src=x onerror='window.pwned=true'>" },
      { type: "toolCall", id: "call-1", name: "console", arguments: { code: "document.title" } },
    ], timestamp: 2, stopReason: "toolUse" };
    const image = { type: "image", mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=" };
    const result = { role: "toolResult", toolCallId: "call-1", toolName: "console", content: [{ type: "text", text: "Pagent" }, image], isError: false, timestamp: 3 };
    const final = { role: "assistant", content: [{ type: "text", text: "Final answer" }], timestamp: 4, stopReason: "stop" };
    for (const message of [user, assistant]) await emit({ type: "message", phase: "end", message }, "main", "prompt-0", runId);
    await emit({ type: "tool", phase: "end", callId: "call-1", name: "console", args: { code: "document.title" }, result: { content: result.content }, isError: false }, "main", "prompt-0", runId);
    assert.equal(await value("main.outputs[0].shadowRoot.querySelector('.tool-body img').src"), `data:image/png;base64,${image.data}`, "live native image renders before the finalized message");
    assert.equal(await value("main.outputs[0].shadowRoot.querySelector('.tool-body').textContent.includes('iVBOR')"), false);
    for (const message of [result, final]) await emit({ type: "message", phase: "end", message }, "main", "prompt-0", runId);
    await emit({ type: "status", status: "idle" }, "main", "prompt-0", runId);
    assert.equal(await value("main.canSubmit"), false, "SDK idle alone never claims a run is completed");
    const complete = { id: runId, agentId: "main", inputId: "prompt-0", status: "complete", result: "Final answer" };
    await value("window.completions = []; window.progress = []; main.addEventListener('complete', event => completions.push(event.detail)); main.addEventListener('progress', event => progress.push(event.detail));");
    await emit({ type: "run", run: complete }, "main", "prompt-0", runId);
    await emit({ type: "saved", revision: "checkpoint" });
    assert.equal(await value("main.result"), "Final answer");
    assert.equal(await value("main.inputs.length"), 2);
    assert.deepEqual(await json("main.messages"), [user, assistant, result, final]);
    assert.equal(await value("main.inputs[0].shadowRoot.querySelector('.editor').contentEditable"), "false");
    assert.equal(await value("main.inputs[0].shadowRoot.querySelector('[data-label]').textContent"), "Submitted");
    assert.equal(await value("main.inputs[0].shadowRoot.querySelector('[data-submit]').hidden"), true);
    assert.equal(await value("main.inputs[1].shadowRoot.querySelector('.editor').contentEditable"), "plaintext-only");
    assert.equal(await value("main.inputs[1].shadowRoot.querySelector('[data-submit]').hidden"), false);
    assert.equal(await value("Boolean(window.pwned)"), false);
    assert.deepEqual(await json("completions"), [complete]);
    assert.equal(await value("progress.some(record => record.runId === main.run.id)"), true);
    assert.equal(await value("main.outputs[0].shadowRoot.textContent.includes('Reasoning') && main.outputs[0].shadowRoot.textContent.includes('Result')"), true);
    assert.equal(await value("[main, ...main.inputs, ...main.outputs].every(node => !node.shadowRoot.querySelector('[data-pagent-state]').textContent.includes('<'))"), true);
    await value("main.inputs.at(-1).value = 'unsent human draft'; document.querySelector('agent-memory').textContent = 'shared-memory-' + 'x'.repeat(20000)");
    assert.equal(await value("pagent.collectContext('main').memory.length > 20000"), true, "memory is not silently truncated");
    assert.equal(await value("pagent.collectContext('main').outline.includes('Final answer')"), false);
    const context = await json("pagent.collectContext('main', main.inputs.at(-1).id)");
    assert.deepEqual(context.history, [user, assistant, result, final]);
    assert.equal(context.prompt, "unsent human draft");

    // Elements can be nested in ordinary divs and inside each other, independently.
    const otherRun = String(await value(`(() => {
      const div = document.createElement('div'); div.id = 'somewhere'; document.body.append(div);
      div.innerHTML = '<p-agent id="research"><div><agent-memory>research-memory</agent-memory><p-agent id="nested"><agent-memory>nested-memory</agent-memory></p-agent></div></p-agent>';
      window.research = $('#research'); window.nested = $('#nested');
      window.researchDraft = research.inputs[0]; researchDraft.value = 'research human draft';
      return research.prompt('Investigate');
    })()`));
    const researchInput = String(await value("research.run.inputId"));
    assert.ok(requests.some(request => request.type === "register" && request.agentId === "research"));
    assert.ok(requests.some(request => request.type === "register" && request.agentId === "nested"));
    assert.deepEqual(requests.at(-1), { type: "submit", agentId: "research", id: researchInput, runId: otherRun }, "insert then prompt works before registration acknowledgement");
    await connected("research");
    assert.equal(await value("research.status"), "running", "registration acknowledgement does not complete a pending submission");
    assert.equal(await value("research.canSubmit"), false);
    assert.equal(await value("research.inputs.at(-1) === researchDraft && researchDraft.value"), "research human draft");
    assert.equal(await value("main.inputs.at(-1).value"), "unsent human draft");
    assert.equal(await value("research.inputs.length"), 2, "nested agent inputs do not become parent history");
    assert.equal(await value("nested.inputs.length"), 1);
    assert.deepEqual(await json("pagent.agents.map(agent => agent.id)"), ["main", "research", "nested"]);
    assert.deepEqual(await json("pagent.collectContext('research').history.map(message => message.content[0].text)"), ["Investigate"]);
    assert.equal(await value("pagent.collectContext('research').memory.includes('research-memory') && !pagent.collectContext('research').memory.includes('nested-memory')"), true);
    assert.equal(await value("pagent.collectContext('nested').memory.includes('nested-memory') && !pagent.collectContext('nested').memory.includes('research-memory')"), true);
    assert.equal(await value("!pagent.collectContext('main').memory.includes('research-memory') && pagent.collectContext('nested').memory.includes('shared-memory')"), true);
    const beforeMove = requests.length;
    await value("document.body.append(research)");
    assert.equal(requests.length, beforeMove, "same-task DOM movement never disposes or registers again");
    await value("research.id = 'renamed'");
    assert.equal(await value("research.id"), "research");
    assert.match(String(await value("research.state.notice")), /cannot be renamed/);
    await value("window.duplicate = document.createElement('p-agent'); duplicate.id = 'research'; document.body.append(duplicate)");
    assert.match(String(await value("duplicate.state.notice")), /Duplicate agent id/);
    assert.equal(await value("(() => { try { duplicate.prompt('wrong'); return false; } catch (error) { return error.message.includes('Duplicate'); } })()"), true);
    await value("duplicate.remove()");
    assert.equal(requests.filter(request => request.type === "dispose").length, 0, "removing an unregistered duplicate cannot dispose the original");
    await emit({ type: "run", run: { id: otherRun, agentId: "research", inputId: researchInput, status: "waiting", result: "" } }, "research", researchInput, otherRun);
    assert.equal(await value("research.status"), "waiting");
    assert.equal(await value("main.status"), "idle");
    await value("research.cancel()");
    assert.deepEqual(requests.at(-1), { type: "cancel", agentId: "research" });
    const cancelled = { id: otherRun, agentId: "research", inputId: researchInput, status: "cancelled", result: "", error: "Cancelled by user" };
    await emit({ type: "run", run: cancelled }, "research", researchInput, otherRun);
    assert.equal(await value("research.status"), "idle");
    assert.equal(await value("research.inputs.at(-1) === researchDraft && researchDraft.value"), "research human draft");
    assert.equal(await value("research.inputs.length"), 2, "programmatic completion does not add an extra draft");
    assert.equal(await value("main.result"), "Final answer");

    const followupRun = String(await value("research.prompt('Programmatic followup')"));
    const followupInput = String(await value("research.run.inputId"));
    const followupAnswer = { role: "assistant", content: [{ type: "text", text: "Completed research" }], timestamp: 5, stopReason: "stop" };
    await emit({ type: "message", phase: "end", message: followupAnswer }, "research", followupInput, followupRun);
    await emit({ type: "run", run: { id: followupRun, agentId: "research", inputId: followupInput, status: "complete", result: "Completed research" } }, "research", followupInput, followupRun);
    assert.equal(await value("research.inputs.at(-1) === researchDraft && researchDraft.value"), "research human draft");
    assert.equal(await value("research.inputs.filter(input => !input.submittedMessage).length"), 1);
    const humanRun = String(await value("research.submit(researchDraft.id)"));
    const humanInput = String(await value("researchDraft.id"));
    assert.deepEqual(await json("pagent.collectContext('research', researchDraft.id).history.map(message => message.content[0].text)"), ["Investigate", "Programmatic followup", "Completed research"], "ordinary human submission retains the intervening completed programmatic turn");
    assert.equal(await value("research.outputs.find(output => output.getAttribute('for') === " + JSON.stringify(followupInput) + ").messages[0].content[0].text"), "Completed research");
    const beforeStale = await json("({state: research.state, webProgress: research.webProgress, webAttention: research.webAttention, messages: research.messages})");
    const staleEvents = [
      { type: "error", message: "Old error" },
      { type: "status", status: "running", model: "stale/model" },
      { type: "web-progress", message: "Old progress" },
      { type: "web-attention", request: { id: "old", reason: "Old challenge", url, tabId: "old" } },
      { type: "message", phase: "end", message: followupAnswer },
      { type: "tool", phase: "start", callId: "old", name: "console" },
      ...["running", "waiting", "complete", "error"].map(status => ({ type: "run", run: { id: followupRun, agentId: "research", inputId: followupInput, status, result: "Stale result" } })),
    ];
    for (const event of staleEvents) await emit(event, "research", followupInput, followupRun);
    await emit({ type: "error", message: "Wrong input" }, "research", followupInput, humanRun);
    await emit({ type: "run", run: { id: humanRun, agentId: "main", inputId: humanInput, status: "error", result: "" } }, "research", humanInput, humanRun);
    assert.deepEqual(await json("({state: research.state, webProgress: research.webProgress, webAttention: research.webAttention, messages: research.messages})"), beforeStale, "all run-scoped events reject stale or mismatched identities");
    await emit({ type: "run", run: { id: humanRun, agentId: "research", inputId: humanInput, status: "complete", result: "Human answer" } }, "research", humanInput, humanRun);
    const afterHuman = await json("research.state");
    for (const event of staleEvents) await emit(event, "research", followupInput, followupRun);
    await emit({ type: "status", status: "running" }, "research", humanInput, humanRun);
    assert.deepEqual(await json("research.state"), afterHuman, "stale events cannot overwrite an idle agent or revive a completed run");
    const disposableRun = String(await value("nested.prompt('still running')"));
    await value("nested.remove()");
    assert.deepEqual(requests.at(-1), { type: "dispose", agentId: "nested" });
    assert.ok(disposableRun.startsWith("run-"));
    const beforeReinsert = requests.length;
    await value("document.body.append(nested)");
    assert.equal(await value("nested.canSubmit"), false);
    assert.match(String(await value("nested.state.notice")), /still being disposed/);
    await value("nested.remove()");
    assert.equal(requests.length, beforeReinsert, "reinserting a closing element neither registers again nor sends a duplicate disposal");
    const beforeReplacement = requests.length;
    await value("window.replacement = document.createElement('p-agent'); replacement.id = 'nested'; document.body.append(replacement)");
    assert.match(String(await value("replacement.state.notice")), /still being disposed/);
    assert.equal(await value("(() => { try { replacement.prompt('too soon'); return false; } catch (error) { return error.message.includes('still being disposed'); } })()"), true);
    assert.equal(requests.length, beforeReplacement, "closing IDs remain reserved without sending another registration");
    const blockedReplacement = await json("replacement.state");
    const disposableInput = String(await value("nested.run.inputId"));
    await emit({ type: "error", message: "Old unscoped engine error" }, "nested");
    await emit({ type: "run", run: { id: disposableRun, agentId: "nested", inputId: disposableInput, status: "cancelled", result: "" } }, "nested", disposableInput, disposableRun);
    assert.deepEqual(await json("replacement.state"), blockedReplacement, "old events never route to a blocked replacement");
    await emit({ type: "disposed" }, "nested");
    assert.equal(await value("replacement.connected"), false, "acknowledgment releases the ID but does not auto-register a replacement");
    assert.equal(await value("(() => { try { replacement.prompt('not registered'); return false; } catch (error) { return error.message.includes('not ready'); } })()"), true);
    const replacementRun = String(await value("replacement.remove(); document.body.append(replacement); replacement.prompt('after disposal')"));
    const replacementInput = String(await value("replacement.run.inputId"));
    assert.deepEqual(requests.slice(-2), [{ type: "register", agentId: "nested" }, { type: "submit", agentId: "nested", id: replacementInput, runId: replacementRun }]);
    await connected("nested");
    const activeReplacement = await json("replacement.state");
    for (const event of [{ type: "error", message: "Late old run" }, { type: "status", status: "running" }, { type: "run", run: { id: disposableRun, agentId: "nested", inputId: disposableInput, status: "complete", result: "Wrong incarnation" } }]) {
      await emit(event, "nested", disposableInput, disposableRun);
    }
    assert.deepEqual(await json("replacement.state"), activeReplacement);
    await emit({ type: "run", run: { id: replacementRun, agentId: "nested", inputId: replacementInput, status: "complete", result: "New incarnation" } }, "nested", replacementInput, replacementRun);
    assert.equal(await value("replacement.result"), "New incarnation");
    await value("replacement.remove()");
    await emit({ type: "disposed" }, "nested");
    // The original element can also be explicitly reinserted after its acknowledgment.
    await value("document.body.append(nested)");
    assert.equal(await value("nested.canSubmit"), true);
    assert.equal(await value("nested.run.status"), "cancelled");
    await value("nested.remove()");
    await emit({ type: "disposed" }, "nested");

    // Reload gates every agent until the restored document is ready.
    await emit({ type: "workspace-state", busy: false, reloading: true });
    const beforeGate = requests.length;
    for (const agent of ["main", "research"]) {
      assert.equal(await value(`${agent}.canSubmit`), false);
      assert.equal(await value(`${agent}.shadowRoot.querySelector('.status').textContent`), "Reloading");
      assert.equal(await value(`(() => { try { ${agent}.prompt('during reload'); return ''; } catch (error) { return error.message; } })()`), "Wait for workspace reload to finish before submitting.");
      assert.equal(await value(`(() => { try { ${agent}.submit(${agent}.inputs[0].id); return ''; } catch (error) { return error.message; } })()`), "Wait for workspace reload to finish before submitting.");
    }
    assert.equal(requests.length, beforeGate);
    assert.equal(await value("main.inputs.at(-1).value"), "unsent human draft");
    assert.equal(await value("research.inputs.at(-1).value"), "");
    await emit({ type: "workspace-state", busy: false });
    assert.equal(await value("main.canSubmit && research.canSubmit"), true, "omitted reload flag clears the gate");

    // Save/Reload share the workspace; research attention remains agent-scoped.
    await value("main.shadowRoot.querySelector('[data-save]').click()");
    assert.deepEqual(requests.at(-1), { type: "save" });
    await emit({ type: "saved", revision: "shared-checkpoint" });
    assert.equal(await value("main.state.notice === research.state.notice"), true);
    await value("research.shadowRoot.querySelector('[data-reload]').click()");
    assert.deepEqual(requests.at(-1), { type: "reload" });
    await value("window.nativeSend = aos.send; aos.send = () => { throw new Error('Native transport unavailable'); }; main.shadowRoot.querySelector('[data-save]').click(); aos.send = nativeSend;");
    assert.equal(await value("main.state.notice"), "Native transport unavailable");

    await connected("research");
    const challenge = { id: "challenge-1", reason: "<img src=x onerror='window.pwned=true'> Complete CAPTCHA", url: "https://example.com/challenge", tabId: "research-1" };
    await emit({ type: "web-progress", message: "Codex unavailable; using research browser." }, "research");
    await emit({ type: "web-attention", request: challenge }, "research");
    assert.equal(await value("research.status"), "waiting");
    assert.equal(await value("main.webAttention"), null);
    assert.equal(await value("research.shadowRoot.querySelector('[data-web-url]').href"), challenge.url);
    assert.equal(await value("research.shadowRoot.querySelector('[data-web-attention] img') === null"), true);
    await value("research.shadowRoot.querySelector('[data-web-continue]').click()");
    assert.deepEqual(requests.at(-1), { type: "web-continue", agentId: "research", id: "challenge-1" });
    const beforeDouble = requests.length;
    await value("research.shadowRoot.querySelector('[data-web-continue]').dispatchEvent(new MouseEvent('click'))");
    assert.equal(requests.length, beforeDouble);
    await emit({ type: "web-attention", request: { ...challenge, id: "challenge-2", url: "javascript:window.pwned=true" } }, "research");
    assert.equal(await value("research.shadowRoot.querySelector('[data-web-url]').hasAttribute('href')"), false);
    await value("research.shadowRoot.querySelector('[data-web-cancel]').click()");
    assert.deepEqual(requests.at(-1), { type: "web-cancel", agentId: "research", id: "challenge-2" });
    await connected("research");
    assert.equal(await value("research.webAttention"), null, "reconnect clears stale authority");
    await emit({ type: "backend-state", state: { configured: "browser", override: null, effective: "browser", source: "environment" } });
    const beforeBackend = requests.filter(request => request.type === "submit").length;
    for (const override of ["auto", "codex", "browser", ""]) {
      await value(`window.backend = research.shadowRoot.querySelector('[data-web-backend]'); backend.value = ${JSON.stringify(override)}; backend.dispatchEvent(new Event('change'))`);
      assert.deepEqual(requests.at(-1), { type: "backend-set", override: override || null });
      assert.equal(await value("backend.value"), "", "only host acknowledgement changes displayed preference");
    }
    await emit({ type: "backend-state", state: { configured: "browser", override: "auto", effective: "auto", source: "override" } });
    assert.equal(await value("main.shadowRoot.querySelector('[data-web-backend]').value"), "auto");
    assert.equal(await value("research.shadowRoot.querySelector('[data-web-backend-state]').textContent"), "Auto · override");
    assert.equal(requests.filter(request => request.type === "submit").length, beforeBackend);

    // Serialized HTML owns records/drafts/cursor, but never host authority or inference.
    const paragraphs = await json("main.outputs[0].paragraphs");
    html = await page.snapshot();
    const snapshotSeq = seq;
    const beforeReload = requests.length;
    await page.reload();
    await setup();
    assert.deepEqual(requests.slice(beforeReload), [{ type: "ready", after: snapshotSeq, agents: [{ agentId: "main" }, { agentId: "research" }] }]);
    assert.equal(await value("main.connected"), false);
    assert.equal(await value("main.webBackend"), null);
    assert.equal(await value("main.webAttention"), null);
    assert.equal(await value("main.inputs.at(-1).value"), "unsent human draft");
    assert.deepEqual(await json("main.messages"), [user, assistant, result, final]);
    assert.deepEqual(await json("main.outputs[0].paragraphs"), paragraphs);
    assert.equal(await value("main.outputs[0].shadowRoot.querySelector('.tool-body img').src"), `data:image/png;base64,${image.data}`, "finalized image survives serialized DOM reload");
    assert.equal(await value("main.outputs[0].state.tools[0].result === undefined"), true, "saved messages own the only state copy of image bytes");
    assert.deepEqual(await json("main.outputs[0].tools[0].result.content"), result.content);
    assert.equal(await value("main.shadowRoot.querySelectorAll('[data-save]').length"), 1);
    assert.equal(await value("main.shadowRoot.querySelectorAll('[data-reload]').length"), 1);
    await page.deliver({ seq: snapshotSeq, agentId: "main", event: { type: "error", message: "Duplicate" } });
    assert.equal(await value("main.state.notice.includes('Duplicate')"), false);
    await connected("main");
    await emit({ type: "workspace-state", busy: false });
    const beforeDuplicate = requests.length;
    assert.match(String(await value("(() => { try { main.submit('prompt-0'); } catch (error) { return error.message; } })()")), /already submitted.*new prompt/);
    assert.match(String(await value("(() => { try { main.inputs[0].value = 'overwrite'; } catch (error) { return error.message; } })()")), /read-only.*new prompt/);
    assert.equal(requests.length, beforeDuplicate, "duplicate submissions never send inference");
    assert.equal(await value("main.inputs[0].shadowRoot.querySelector('.editor').contentEditable"), "false", "submitted messages remain read-only after reload");
    await value(`(() => {
      window.postedInput = main.inputs[0]; window.postedOutput = main.outputs[0];
      window.humanDraft = main.inputs.at(-1);
      window.earlierDraft = main.addInput(postedInput); earlierDraft.value = 'A new turn from an earlier draft';
      const note = document.createElement('p'); note.id = 'user-artifact'; note.textContent = 'Keep me'; main.append(note);
    })()`);
    assert.deepEqual(await json("pagent.collectContext('main', earlierDraft.id).history"), [user, assistant, result, final], "selecting an earlier draft does not hide later completed turns");
    const nextRun = String(await value("main.submit(earlierDraft.id)"));
    const nextInput = String(await value("earlierDraft.id"));
    assert.notEqual(nextRun, runId, "new turns get new run identity");
    assert.equal(await value("main.inputs.length"), 3);
    assert.equal(await value("main.inputs[0] === postedInput && main.outputs[0] === postedOutput && main.inputs[1] === earlierDraft && main.inputs[2] === humanDraft"), true, "only the newly submitted draft moves after existing turns");
    assert.deepEqual(await json("main.outputs[0].messages"), [assistant, result, final]);
    assert.deepEqual(await json("pagent.collectContext('main', earlierDraft.id).history"), [user, assistant, result, final]);
    assert.equal(await value("pagent.collectContext('main', earlierDraft.id).prompt"), "A new turn from an earlier draft");
    assert.equal(await value("humanDraft.value"), "unsent human draft");
    assert.equal(await value("Boolean($('#user-artifact'))"), true);
    assert.equal(await value("pagent.agents.length"), 2, "new turns never remove unrelated agents");
    await emit({ type: "error", message: "Deliberate failure" }, "main", nextInput, nextRun);
    assert.equal(await value("main.canSubmit"), false);
    assert.equal(await value("main.outputs[1].shadowRoot.textContent.includes('Deliberate failure')"), true);
    await emit({ type: "run", run: { id: nextRun, agentId: "main", inputId: nextInput, status: "error", result: "", error: "Deliberate failure" } }, "main", nextInput, nextRun);
    assert.equal(await value("main.status"), "error");
    assert.equal(await value("main.canSubmit"), true);
    assert.equal(await value("main.inputs.length"), 3);
    assert.deepEqual((await json("main.messages")).slice(0, 4), [user, assistant, result, final], "later failure preserves earlier history");
    // Earlier terminal records in the outbox must not replace the newer run saved in HTML.
    const replayRun = String(await value("main.prompt('complete across reload')"));
    const replayInput = String(await value("main.run.inputId"));
    html = await page.snapshot();
    await page.reload();
    await setup();
    await emit({ type: "run", run: complete }, "main", "prompt-0", runId);
    await emit({ type: "run", run: { id: nextRun, agentId: "main", inputId: nextInput, status: "error", result: "", error: "Old failure" } }, "main", nextInput, nextRun);
    assert.equal(await value("main.run.id"), replayRun);
    assert.equal(await value("main.state.busy"), true);
    const replayComplete = { id: replayRun, agentId: "main", inputId: replayInput, status: "complete", result: "Replayed completion" };
    await emit({ type: "run", run: replayComplete }, "main", replayInput, replayRun);
    await connected("main", false, replayComplete);
    assert.equal(await value("main.result"), "Replayed completion");
    assert.equal(await value("main.canSubmit"), true);
    const interrupted = String(await value("main.prompt('restart during this run')"));
    html = await page.snapshot();
    const beforeRestart = requests.filter(request => request.type === "submit").length;
    await page.reload();
    await setup();
    await connected("main");
    assert.equal(await value("main.run.id"), interrupted);
    assert.equal(await value("main.run.status"), "cancelled");
    assert.equal(await value("main.state.busy"), false);
    assert.equal(requests.filter(request => request.type === "submit").length, beforeRestart, "restart never resumes old inference automatically");

    await value("for (const agent of pagent.agents) agent.remove()");
    await emit({ type: "disposed" }, "main");
    await emit({ type: "disposed" }, "research");
    html = await page.snapshot();
    await page.reload();
    assert.deepEqual(requests.at(-1), { type: "ready", after: seq, agents: [] });
    await emit({ type: "workspace-state", busy: false });
    const emptyPageRun = String(await value("window.fresh = document.createElement('p-agent'); fresh.id = 'fresh'; document.body.append(fresh); fresh.prompt('first agent after reconnect')"));
    assert.deepEqual(requests.slice(-2), [{ type: "register", agentId: "fresh" }, { type: "submit", agentId: "fresh", id: await value("fresh.run.inputId"), runId: emptyPageRun }], "zero-agent reconnect establishes live transport before same-eval registration/submission");
  });
}
