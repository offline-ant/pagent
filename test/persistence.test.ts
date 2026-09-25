import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { launchBrowser } from "../src/browser.ts";
import type { AgentEvent, BrowserKind, BrowserLog, PageBrowser } from "../src/protocol.ts";

const template = fileURLToPath(new URL("../template/", import.meta.url));
const files = new Set(["agent.js", "agent-persistence.js", "agent-connection.js", "agent-controls.js", "p-agent.js", "user-input.js", "agent-output.js", "dom.js", "paragraphs.js", "agent.css"]);

async function fixture(t: TestContext, engine: BrowserKind, markup: string) {
  const directory = await mkdtemp(join(tmpdir(), `pagent-persistence-${engine}-`));
  const requests: Array<Record<string, unknown>> = [];
  const logs: BrowserLog[] = [];
  const server = createServer(async (request, response) => {
    response.setHeader("Cache-Control", "no-store");
    const resource = request.url?.slice(1) ?? "";
    try {
      if (files.has(resource)) {
        response.setHeader("Content-Type", resource.endsWith(".js") ? "text/javascript" : "text/css");
        response.end(await readFile(join(template, resource)));
      } else {
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.end(`<!doctype html><html><head><script type="module" src="/agent.js"></script></head><body>${markup}</body></html>`);
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
    url, onRequest: request => requests.push(request as Record<string, unknown>), onConsole: entry => logs.push(entry) });
  const value = (code: string) => browser!.evaluateValue(code);
  const json = async (code: string): Promise<unknown> => JSON.parse(String(await value(`JSON.stringify(${code})`)));
  let seq = 0;
  const emit = (event: AgentEvent, agentId?: string, requestId?: string, runId?: string) => browser!.deliver({ seq: ++seq, event, agentId, requestId, runId });
  for (const id of await json("pagent.agents.map(a => a.id)") as string[]) {
    await emit({ type: "connected", url, model: "fake/model", busy: false }, id);
  }
  await emit({ type: "workspace-state", busy: false });
  // Registration remains a real page operation; no fake host inference is needed.
  await value(`window.addAgent = (id, attributes = '', content = '') => {
    const holder = document.createElement('div');
    holder.innerHTML = '<p-agent id="' + id + '" ' + attributes + '>' + content + '</p-agent>';
    const agent = holder.firstElementChild; document.body.append(agent); return agent;
  };`);
  return { value, json, emit, requests, logs };
}

for (const engine of ["chromium", "firefox"] as const) {
  for (const edge of ["start", "end"] as const) {
    test(`${engine}: persistent ${edge} retains six original conversations in registration order`, { timeout: 45_000 }, async t => {
      const ids = ["a1", "a2", "b1", "b2", "c1", "c2"];
      const f = await fixture(t, engine, ids.map(id => `<p-agent id="${id}" persist-${edge}="body"></p-agent>`).join(""));
      await f.value(`window.originals = pagent.agents; window.roots = originals.map(a => a.shadowRoot);
        window.drafts = originals.map(a => a.inputs[0]);
        drafts.forEach((draft, index) => draft.value = 'human draft ' + index);
        window.runs = originals.map(a => a.prompt('prior user turn ' + a.id));
        window.listenerCalls = 0; originals.forEach(a => a.addEventListener('probe', () => listenerCalls++));`);
      for (const id of ids) {
        const run = await f.json(`$('#${id}').run`) as { id: string; inputId: string };
        await f.emit({ type: "message", phase: "end", message: { role: "assistant", content: [{ type: "text", text: `answer ${id}` }], timestamp: 1 } }, id, run.inputId, run.id);
        await f.emit({ type: "run", run: { id: run.id, agentId: id, inputId: run.inputId, status: "complete", result: `answer ${id}` } }, id, run.inputId, run.id);
      }
      await f.value(`window.histories = originals.map(a => JSON.stringify(a.messages));
        originals.toReversed().forEach(a => document.body.append(a));`);
      const before = f.requests.length;
      await f.value(`document.body.innerHTML = '<article id="artwork">new world</article>'`);
      assert.deepEqual(await f.json("pagent.agents.map(a => a.id)"), ids);
      assert.deepEqual(await f.json("[...document.body.children].map(a => a.id)"), edge === "start" ? [...ids, "artwork"] : ["artwork", ...ids]);
      assert.equal(await f.value(`originals.every((a, i) => document.getElementById(a.id) === a && a.shadowRoot === roots[i] && a.inputs.at(-1) === drafts[i] && drafts[i].value === 'human draft ' + i && JSON.stringify(a.messages) === histories[i] && a.run.id === runs[i])`), true);
      await f.value("originals.forEach(a => a.dispatchEvent(new Event('probe')))");
      assert.equal(await f.value("listenerCalls"), 6);
      assert.deepEqual(f.requests.slice(before), [], "restoration sends no native request");

      await f.value(`document.body.innerHTML = document.body.innerHTML`);
      assert.equal(await f.value("originals.every((a,i) => document.getElementById(a.id) === a && a.shadowRoot === roots[i] && JSON.stringify(a.messages) === histories[i])"), true, "parsed duplicates cannot adopt the originals' identities or replace history");
      assert.deepEqual(await f.json("pagent.agents.map(a => a.id)"), ids);
      assert.deepEqual(f.requests.slice(before), [], "parsed duplicates neither register nor dispose");

      await f.value(`originals[0].remove(); originals[0].id = 'changed';
        originals[0].removeAttribute('persist-${edge}'); originals[0].setAttribute('model', 'changed/model');
        originals[0].setAttribute('persist-${edge === "start" ? "end" : "start"}', 'body');`);
      assert.equal(await f.value(`originals[0].id === 'a1' && originals[0].getAttribute('persist-${edge}') === 'body' && !originals[0].hasAttribute('model') && !originals[0].hasAttribute('persist-${edge === "start" ? "end" : "start"}')`), true, "all configuration is pinned during detached recovery");
      assert.match(String(await f.value("originals[0].state.notice")), /pinned/);
      assert.deepEqual(f.requests.slice(before), []);

      await f.value(`window.plain = addAgent('plain'); window.destination = document.createElement('section'); document.body.append(destination)`);
      const beforeMoves = f.requests.length;
      await f.value("destination.append(plain); plain.remove(); queueMicrotask(() => destination.append(plain))");
      assert.equal(await f.value("plain.isConnected && plain.parentElement === destination"), true);
      assert.deepEqual(f.requests.slice(beforeMoves), [], "same-task and queued-microtask moves do not dispose ordinary agents");
      await f.value("plain.remove()");
      assert.deepEqual(f.requests.at(-1), { type: "dispose", agentId: "plain" });
      await f.emit({ type: "disposed" }, "plain");
      await f.value("plain.setAttribute('persist-end', 'body'); plain.id = 'plain-reconfigured'; document.body.append(plain)");
      assert.deepEqual(f.requests.at(-1), { type: "register", agentId: "plain-reconfigured" });
      assert.equal(await f.value("plain.getAttribute('persist-end')"), "body", "acknowledgment releases pinned configuration");
    });
  }

  test(`${engine}: mixed insertion edges keep registration order independently across replacement targets`, { timeout: 40_000 }, async t => {
    const declarations = [
      ["left-end-1", "end", "left"], ["right-start-1", "start", "right"],
      ["left-start-1", "start", "left"], ["right-end-1", "end", "right"],
      ["left-start-2", "start", "left"], ["right-end-2", "end", "right"],
      ["left-end-2", "end", "left"], ["right-start-2", "start", "right"],
    ];
    const targets = '<section id="left"><b id="left-marker">left artwork</b></section><section id="right"><b id="right-marker">right artwork</b></section>';
    const markup = targets + declarations.map(([id, edge, target]) => `<p-agent id="${id}" persist-${edge}="#${target}"></p-agent>`).join("");
    const f = await fixture(t, engine, markup);
    await f.value("window.originals = pagent.agents; originals.toReversed().forEach(agent => document.body.append(agent))");
    const before = f.requests.length;
    await f.value(`document.body.innerHTML = ${JSON.stringify(targets)}`);
    for (const target of ["left", "right"]) {
      assert.deepEqual(await f.json(`[...document.getElementById('${target}').children].map(node => node.id)`), [
        `${target}-start-1`, `${target}-start-2`, `${target}-marker`, `${target}-end-1`, `${target}-end-2`,
      ]);
    }
    assert.equal(await f.value("originals.every(agent => document.getElementById(agent.id) === agent && agent.isConnected)"), true);
    assert.deepEqual(f.requests.slice(before), [], "mixed restoration neither registers nor disposes identities");
  });

  test(`${engine}: nested restoration precedes child rescue and explicit disposal`, { timeout: 40_000 }, async t => {
    const f = await fixture(t, engine, '<p-agent id="base" persist-end="body"></p-agent>');
    await f.value(`window.child = addAgent('child', 'persist-end="body"');
      window.parentAgent = addAgent('parent', 'persist-end="body"');
      parentAgent.append(child); window.ordinary = addAgent('ordinary'); parentAgent.append(ordinary);`);
    const before = f.requests.length;
    await f.value("parentAgent.remove()");
    assert.equal(await f.value("parentAgent.isConnected && child.parentElement === parentAgent && ordinary.parentElement === parentAgent"), true, "ancestor recovers first even if registered later than the child");
    assert.deepEqual(f.requests.slice(before), []);
    await f.value("parentAgent.dispose()");
    assert.equal(await f.value("!parentAgent.isConnected && child.isConnected && child.parentElement === document.body && !ordinary.isConnected"), true, "explicit parent disposal rescues independently persistent children only");
    assert.deepEqual(f.requests.slice(before).filter(r => r.type === "dispose").map(r => r.agentId).sort(), ["ordinary", "parent"]);
    await f.value("child.dispose()");
    assert.equal(await f.value("child.isConnected"), false);
    assert.deepEqual(f.requests.at(-1), { type: "dispose", agentId: "child" });
    await f.value("document.body.append(child); child.remove()");
    assert.equal(f.requests.filter(r => r.type === "dispose" && r.agentId === "child").length, 1, "closing identity cannot send duplicate disposal");
  });

  test(`${engine}: persistence resolves fresh targets and fails explicitly without deleting artwork`, { timeout: 45_000 }, async t => {
    const f = await fixture(t, engine, '<section id="target"></section><p-agent id="base" persist-end="#target"></p-agent>');
    await f.value("window.base = $('#base'); window.oldTarget = $('#target'); oldTarget.append(base); oldTarget.outerHTML = '<section id=target><b>new container</b></section>'");
    assert.equal(await f.value("base.isConnected && base.parentElement === $('#target') && base.parentElement !== oldTarget"), true);
    await f.value("$('#target').remove()");
    assert.equal(await f.value("base.parentElement === document.body"), true);
    await delay(30);
    assert.ok(f.logs.some(entry => entry.level === "warn" && entry.text.includes("falling back")));

    const invalid = [
      ["empty", 'persist-end="   "', ""],
      ["both", 'persist-start="body" persist-end="body"', ""],
      ["syntax", 'persist-end="["', ""],
      ["self", 'persist-end="#self"', ""],
      ["subtree", 'persist-end="#inside"', '<section id="inside"></section>'],
      ["void", 'persist-end="#void-target"', ""],
    ];
    await f.value("document.body.insertAdjacentHTML('beforeend', '<input id=void-target>')");
    const beforeInvalid = f.requests.length;
    for (const [id, attributes, content] of invalid) {
      await f.value(`addAgent(${JSON.stringify(id)}, ${JSON.stringify(attributes)}, ${JSON.stringify(content)})`);
      assert.equal(await f.value(`Boolean($('#${id}').state.error && $('#${id}').state.notice && !$('#${id}').identity)`), true, `${id} rejected before native registration`);
    }
    assert.deepEqual(f.requests.slice(beforeInvalid), []);

    await f.value("window.collision = addAgent('collision', 'persist-end=body'); collision.remove(); document.body.insertAdjacentHTML('beforeend', '<article id=collision>do not delete me</article>')");
    assert.equal(await f.value("!collision.isConnected && document.getElementById('collision').textContent"), "do not delete me");
    assert.match(String(await f.value("collision.state.notice")), /duplicate/i);
    assert.deepEqual(f.requests.at(-1), { type: "dispose", agentId: "collision" });

    // A selector that becomes self/subtree only after attachment cannot cycle.
    await f.value("window.changed = addAgent('changed', 'persist-end=.destination'); changed.className = 'destination'; changed.remove()");
    // A detached self no longer matches document.querySelector; missing target uses body.
    assert.equal(await f.value("changed.isConnected && changed.parentElement === document.body"), true);
    await f.value("window.owner = addAgent('owner', 'persist-end=body'); window.targetChild = addAgent('target-child', 'persist-end=#target-child-container'); window.container = document.createElement('section'); container.id='target-child-container'; document.body.append(container); targetChild.append(container); targetChild.remove()");
    assert.equal(await f.value("targetChild.isConnected"), true, "detached subtree matches are absent from document lookup and fall back to body");

    const beforeNoBody = f.requests.filter(r => r.type === "dispose").length;
    await f.value("document.body.remove()");
    assert.equal(await f.value("document.body"), null);
    assert.equal(await f.value("base.isConnected"), false);
    assert.match(String(await f.value("base.state.notice")), /connected HTML container/);
    assert.ok(f.requests.filter(r => r.type === "dispose").length > beforeNoBody);
    const disposed = f.requests.filter(r => r.type === "dispose").length;
    await delay(30);
    assert.equal(f.requests.filter(r => r.type === "dispose").length, disposed, "failure is one normal disposal, not retry polling");
  });

  test(`${engine}: cancelled unload does not disable persistence in the surviving document`, { timeout: 35_000 }, async t => {
    const f = await fixture(t, engine, '<p-agent id="one" persist-end="body"></p-agent>');
    const before = f.requests.length;
    assert.equal(await f.value(`(() => {
      window.addEventListener('beforeunload', event => event.preventDefault(), { once: true });
      const event = new Event('beforeunload', { cancelable: true });
      window.dispatchEvent(event);
      window.one = $('#one'); one.remove();
      return event.defaultPrevented;
    })()`), true);
    assert.equal(await f.value("one.isConnected && $('#one') === one"), true);
    assert.deepEqual(f.requests.slice(before), []);
  });

  for (const suppression of ["stop", "host-stop", "reload", "pagehide"] as const) {
    test(`${engine}: ${suppression} suppresses pending persistent recovery`, { timeout: 35_000 }, async t => {
      const f = await fixture(t, engine, '<p-agent id="one" persist-end="body"></p-agent>');
      if (suppression === "host-stop") await f.emit({ type: "execution-state", state: "stopped" });
      if (suppression === "reload") await f.emit({ type: "workspace-state", busy: false, reloading: true });
      await f.value(`window.one = $('#one'); one.remove(); ${suppression === "stop" ? "pagent.stop();" : suppression === "pagehide" ? "window.dispatchEvent(new PageTransitionEvent('pagehide'));" : ""}`);
      assert.equal(await f.value("one.isConnected"), false);
      assert.deepEqual(f.requests.at(-1), { type: "dispose", agentId: "one" });
      assert.equal(f.requests.filter(r => r.type === "register" || r.type === "submit").length, 0);
    });
  }
}
