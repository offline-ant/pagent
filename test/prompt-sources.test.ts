import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { launchBrowser } from "../src/browser.ts";
import { startServer } from "../src/server.ts";
import { startSession, type PagentSession, type SessionOptions } from "../src/session.ts";
import { openWorkspace } from "../src/storage.ts";
import type { BrowserKind, PageBrowser } from "../src/protocol.ts";
import type { TurnPrompts } from "../src/turn-prompts.ts";
import { agentConfiguration, promptSource } from "../src/agent-config.ts";

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) { if (await check()) return; await delay(20); }
  throw new Error("Prompt condition timed out.");
}
const escape = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");
async function fixture(kind: BrowserKind, html: string, options: Partial<SessionOptions> = {}) {
  const directory = await mkdtemp(join(tmpdir(), "pagent-prompts-"));
  const workspace = await openWorkspace({ directory, templateDir: fileURLToPath(new URL("../template/", import.meta.url)) });
  await workspace.write("/index.html", Buffer.from(`<!doctype html><script type="module" src="/agent.js"></script>${html}`));
  const server = await startServer(workspace);
  let session: PagentSession | undefined;
  let browser: PageBrowser | undefined;
  const logs: string[] = [];
  async function close() {
    await session?.close(); await browser?.close(); await server.close(); await workspace.close();
    await rm(directory, { recursive: true, force: true });
  }
  try {
    session = await startSession({ workspace, url: server.url, browserKind: kind, fake: true,
      checkpoint: "none", tools: ["console"], log: text => logs.push(text), onClose: () => {}, ...options,
      createBrowser: async settings => {
        browser = await launchBrowser({ ...settings, browser: kind, headless: true, profileDir: join(workspace.stateDirectory, kind),
          noSandbox: kind === "chromium" && process.env.PAGENT_TEST_NO_SANDBOX === "1" });
        return browser;
      } });
    const evaluate = (code: string) => session!.browser.evaluateValue(code);
    const done = () => until(async () => {
      const run = await evaluate("$('#one').run") as { status?: string; error?: string } | null;
      assert.notEqual(run?.status, "error", `${run?.error}\n${logs.join("\n")}`);
      return run?.status === "complete";
    }).catch(async error => {
      const state = await evaluate("(() => { const a=$('#one'); return {run:a.run, seq:a.lastSeq, outputBytes:JSON.stringify(a.outputs.at(-1)?.state).length, previousResponseBytes:a.result.length}; })()");
      throw new Error(`${String(error)}; engineBusy=${session!.agents.get('one')?.busy}; page=${JSON.stringify(state)}; logs=${logs.join(' | ')}`);
    });
    const inspected = async () => JSON.parse(String(await evaluate("$('#one').result"))) as { systemPrompt: string };
    const evidence = async () => {
      const root = join(workspace.stateDirectory, "turn-prompts");
      return Promise.all((await readdir(root)).map(async name => JSON.parse(await readFile(join(root, name), "utf8")) as { agentId: string; inputId: string; runId: string; prompts: TurnPrompts }));
    };
    return { session, workspace, evaluate, done, inspected, evidence, close, logs };
  } catch (error) { await close(); throw error; }
}

test("canonical sources reject legacy keys and malformed declarations", () => {
  for (const key of ["systemPrompt", "repeatPrompt"]) assert.throws(() => agentConfiguration({ [key]: "old" }), /removed/);
  for (const source of [null, "x", {}, {kind:"other",value:"x"}, {kind:"raw",value:" "}, {kind:"el",value:"x",extra:true}, {kind:"raw",value:"é".repeat(65537)}, {kind:"url",value:"https://example.com/x"}, {kind:"url",value:"../x"}]) assert.throws(() => promptSource(source));
  for (const kind of ["raw", "url", "el"]) assert.deepEqual(promptSource({kind,value:"thing"}), {kind,value:"thing"});
});

for (const kind of ["chromium", "firefox"] as const) {
  test(`${kind} shared DOM sources resolve once per turn, survive edits and record exact private evidence`, { timeout: 40_000 }, async () => {
    const firstTask = `/fake-console-system-prompt (() => { $('#instructions').textContent='second system'; $('#task').textContent='/fake-system-prompt'; })()`;
    const f = await fixture(kind, `<pre id="instructions" contenteditable>first system</pre><pre id="task" contenteditable>${escape(firstTask)}</pre><p-agent id="one" system-prompt-el="#instructions" repeat-prompt-el="#task"></p-agent>`);
    try {
      await f.session.start(); await f.done();
      assert.equal((await f.inspected()).systemPrompt, "first system", "tool rounds keep the snapshot even after editing its source");
      const firstRun = await f.evaluate("$('#one').run.id");
      await f.session.start(); await f.done();
      assert.notEqual(await f.evaluate("$('#one').run.id"), firstRun);
      assert.equal((await f.inspected()).systemPrompt, "second system");
      await f.evaluate("$('#one').setAttribute('system-prompt-el','#task')");
      assert.equal(await f.evaluate("$('#one').getAttribute('system-prompt-el')"), "#instructions");
      const records = await f.evidence();
      assert.equal(records.length, 2);
      const first = records.find(record => record.runId === firstRun)!;
      assert.equal(first.prompts.system.text, "first system");
      assert.deepEqual(first.prompts.user, {source:{kind:"el",value:"#task"},text:firstTask});
      assert.ok(Number.isFinite(Date.parse(first.prompts.resolvedAt)));
      const latest = records.find(record => record.runId !== firstRun)!;
      assert.deepEqual(await f.evaluate("$('#one').outputs.at(-1).state.prompts"), latest.prompts);
      const html = await f.session.browser.snapshot();
      assert.match(html, /first system/);
      assert.match(html, /resolvedAt/);
      assert.equal(await f.evaluate("$('#one').messages.some(m => m.role === 'system')"), false);
      await f.evaluate("$('#instructions').textContent=' '");
      await f.session.start();
      assert.equal((await f.evidence()).length, 2, "invalid resolution never enters inference");
      assert.match(f.logs.join("\n"), /nonempty/);
    } finally { await f.close(); }
  });

  test(`${kind} local file sources reload between turns, not tool rounds; manual submissions resolve system too`, { timeout: 40_000 }, async () => {
    const f = await fixture(kind, '<p-agent id="one" system-prompt-url="./system.md" repeat-prompt-url="./task.md"></p-agent>');
    try {
      await f.workspace.write("system.md", Buffer.from("first file"));
      await f.workspace.write("task.md", Buffer.from(`/fake-console-system-prompt fetch('/system.md',{method:'PUT',body:'second file'}).then(r => r.status)`));
      const counts = new Map<string, number>();
      const read = f.workspace.read.bind(f.workspace);
      f.workspace.read = resource => { counts.set(resource, (counts.get(resource) ?? 0) + 1); return read(resource); };
      await f.session.start(); await f.done();
      assert.equal((await f.inspected()).systemPrompt, "first file");
      await f.workspace.write("task.md", Buffer.from("/fake-system-prompt"));
      await f.session.start(); await f.done();
      assert.equal((await f.inspected()).systemPrompt, "second file");
      assert.equal(counts.get("system.md"), 2); assert.equal(counts.get("task.md"), 2);
      await f.workspace.write("system.md", Buffer.from("manual system"));
      await f.evaluate("(() => {const a=$('#one');const i=a.inputs.find(i=>!i.submittedMessage);i.value='/fake-system-prompt';a.submit(i.id);})()");
      await f.done();
      assert.equal((await f.inspected()).systemPrompt, "manual system");
      const records = await f.evidence();
      assert.equal(records.length, 3);
      assert.deepEqual(records.find(r=>r.prompts.system.text === "manual system")!.prompts.user.source, {kind:"raw",value:"/fake-system-prompt"});
      assert.equal(counts.get("task.md"), 2, "manual input never resolves repeat source");
      await f.workspace.write("system.md", Buffer.from([0xff]));
      await f.evaluate("$('#one').prompt('/fake-inspect')");
      await until(async () => await f.evaluate("$('#one').run.status === 'error'") === true);
      assert.match(String(await f.evaluate("$('#one').run.error")), /encoded data|encoding/);
      await f.workspace.write("system.md", Buffer.alloc(128*1024+1, 65));
      await f.evaluate("$('#one').prompt('/fake-inspect')");
      await until(async () => await f.evaluate("$('#one').run.status === 'error'") === true);
      assert.match(String(await f.evaluate("$('#one').run.error")), /128 KiB/);
      assert.equal((await f.evidence()).length, 3);
    } finally { await f.close(); }
  });

  test(`${kind} raw/default prompts and invalid DOM/legacy/conflicting declarations fail clearly`, { timeout: 40_000 }, async () => {
    const f = await fixture(kind, '<p-agent id="one" system-prompt-raw=" literal &amp; system " repeat-prompt-raw="/fake-system-prompt"></p-agent><p-agent id="default"></p-agent><i class="multi">a</i><i class="multi">b</i><i id="empty"></i><i id="large"></i>');
    try {
      await f.session.start(); await f.done();
      assert.equal((await f.inspected()).systemPrompt, " literal & system ");
      await f.evaluate("$('#default').prompt('/fake-system-prompt')");
      await until(async () => await f.evaluate("$('#default').run?.status === 'complete'") === true);
      const defaultRecord = (await f.evidence()).find(r=>r.agentId === "default")!;
      assert.equal(defaultRecord.prompts.system.source, null);
      assert.equal(defaultRecord.prompts.system.text, JSON.parse(String(await f.evaluate("$('#default').result"))).systemPrompt);
      await f.evaluate("$('#large').textContent='é'.repeat(65537);const h=document.createElement('div');h.attachShadow({mode:'open'}).innerHTML='<i id=shadow>hidden</i>';document.body.append(h)");
      for (const [index, selector] of ["[", "#absent", ".multi", "#empty", "#large", "#shadow"].entries()) {
        const id = `bad${index}`;
        await f.evaluate(`(() => { const a=document.createElement('p-agent');a.id=${JSON.stringify(id)};a.setAttribute('system-prompt-el',${JSON.stringify(selector)});document.body.append(a); })()`);
        await until(async () => await f.evaluate(`$('#${id}').connected`) === true);
        await f.evaluate(`$('#${id}').prompt('/fake-inspect')`);
        await until(async () => await f.evaluate(`$('#${id}').run?.status === 'error'`) === true);
        assert.match(String(await f.evaluate(`$('#${id}').run.error`)), /selector|text/i);
      }
      for (const [index, attrs] of [
        {"system-prompt":"old.md"}, {"repeat-prompt":"old"},
        {"system-prompt-raw":"x","system-prompt-el":"#empty"},
        {"repeat-prompt-raw":"x","repeat-prompt-url":"task.md"},
        {"system-prompt-el":" "},
      ].entries()) {
        const id = `invalid${index}`;
        await f.evaluate(`(() => { const a=document.createElement('p-agent');a.id=${JSON.stringify(id)};for(const [key,value] of Object.entries(${JSON.stringify(attrs)}))a.setAttribute(key,value);document.body.append(a); })()`);
        assert.equal(f.session.agents.has(id), false);
        assert.match(String(await f.evaluate(`$('#${id}').state.notice`)), /no longer supported|exactly one|nonempty/i);
      }
      await symlink(join(f.workspace.directory,"index.html"), join(f.workspace.directory,"linked.md"));
      await f.evaluate("(() => { const a=document.createElement('p-agent');a.id='linked';a.setAttribute('repeat-prompt-url','linked.md');document.body.append(a); })()");
      await until(()=>f.session.agents.has("linked"));
      assert.equal((await f.evidence()).length, 2);
    } finally { await f.close(); }
  });

  test(`${kind} operator continuation takes fresh shared prompt snapshots`, { timeout: 30_000 }, async () => {
    const f = await fixture(kind, '<pre id="system">first interval</pre><pre id="task">/fake-system-prompt</pre><p-agent id="one" system-prompt-el="#system" repeat-prompt-el="#task"></p-agent>', {durationMs: kind === "firefox" ? 8000 : 2000,deadlinePolicy:"pause"});
    try {
      await f.session.start(); await f.done();
      assert.equal((await f.inspected()).systemPrompt,"first interval");
      await until(()=>f.session.executionState === "paused");
      await f.evaluate("$('#system').textContent='second interval';$('#task').textContent='/fake-console-system-prompt 42'");
      await f.session.continue(); await f.done();
      assert.equal((await f.inspected()).systemPrompt,"second interval");
      assert.equal((await f.evidence()).length,2);
    } finally { await f.close(); }
  });
}
