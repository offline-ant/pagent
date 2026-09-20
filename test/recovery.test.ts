import assert from "node:assert/strict";
import { access, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { recoverWorkspace } from "../src/recovery.ts";
import { openWorkspace, StorageError, type Workspace } from "../src/storage.ts";

const templateDir = fileURLToPath(new URL("../template/", import.meta.url));
const savedHTML = '<!doctype html><p-agent id="main"><template shadowrootmode="open" shadowrootserializable><p>Old conversation and unsent draft</p></template></p-agent>';

async function fixture(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pagent-recovery-"));
  let workspace: Workspace | undefined;
  t.after(async () => {
    try { await workspace?.close(); }
    finally { await rm(root, { recursive: true, force: true }); }
  });
  workspace = await openWorkspace({ directory: path.join(root, "workspace"), templateDir });
  const logs: string[] = [];
  return { root, workspace, log: (message: string) => { logs.push(message); }, logs };
}

async function recoveryDirectory(workspace: Workspace): Promise<string> {
  const directory = path.join(workspace.stateDirectory, "recovery");
  const backups = await readdir(directory);
  assert.equal(backups.length, 1);
  return path.join(directory, backups[0]);
}

test("reset UI restores every template file, creates missing helpers, and backs up only overwritten resources", async t => {
  const { workspace, log, logs } = await fixture(t);
  const names = (await readdir(templateDir, { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => entry.name);
  const originals = new Map<string, string>();
  for (const name of names) {
    const original = name === "index.html" ? savedHTML : `broken original ${name}`;
    originals.set(name, original);
    await workspace.write(name, Buffer.from(original));
  }
  await rm(path.join(workspace.directory, "dom.js"));
  originals.delete("dom.js");
  await workspace.write("generated.js", Buffer.from("generated application resource"));
  await workspace.write("research/notes.html", Buffer.from("keep research"));
  const outbox = path.join(workspace.stateDirectory, "outbox.jsonl");
  await writeFile(outbox, "old pending events\n");

  await recoverWorkspace(workspace, templateDir, { resetUI: true, log });

  const backup = await recoveryDirectory(workspace);
  for (const name of names) {
    assert.deepEqual(await workspace.read(name), await readFile(path.join(templateDir, name)), name);
  }
  for (const [name, original] of originals) {
    assert.equal(await readFile(path.join(backup, name), "utf8"), original, name);
  }
  assert.deepEqual((await readdir(backup)).sort(), [...originals.keys(), "outbox.jsonl"].sort());
  assert.equal(await readFile(path.join(backup, "outbox.jsonl"), "utf8"), "old pending events\n");
  await assert.rejects(access(outbox), { code: "ENOENT" });
  assert.equal((await workspace.read("generated.js")).toString(), "generated application resource");
  assert.equal((await workspace.read("research/notes.html")).toString(), "keep research");
  assert.deepEqual(logs, [`Restored starter UI. Previous files are backed up at ${backup}`]);
});

for (const restore of ["latest", "filename"]) {
  test(`HTML-only recovery by ${restore} preserves external resources and archives the outbox`, async t => {
    const { workspace, log, logs } = await fixture(t);
    const revision = await workspace.checkpoint(savedHTML);
    await workspace.write("index.html", Buffer.from("broken document"));
    await workspace.write("paragraphs.js", Buffer.from("custom helper"));
    await workspace.write("agent.js", Buffer.from("custom UI"));
    const outbox = path.join(workspace.stateDirectory, "outbox.jsonl");
    await writeFile(outbox, "old pending events\n");

    await recoverWorkspace(workspace, templateDir, { restore: restore === "latest" ? restore : revision, log });

    assert.equal((await workspace.read("index.html")).toString(), savedHTML);
    assert.equal((await workspace.read("paragraphs.js")).toString(), "custom helper");
    assert.equal((await workspace.read("agent.js")).toString(), "custom UI");
    const backup = await recoveryDirectory(workspace);
    assert.deepEqual(await readdir(backup), ["outbox.jsonl"]);
    assert.equal(await readFile(path.join(backup, "outbox.jsonl"), "utf8"), "old pending events\n");
    await assert.rejects(access(outbox), { code: "ENOENT" });
    assert.deepEqual(logs, [`Restored HTML checkpoint ${revision}. External resources are unchanged.`]);
  });
}

test("combined recovery still restores HTML before resetting UI, with no outbox required", async t => {
  const { workspace, log } = await fixture(t);
  const revision = await workspace.checkpoint(savedHTML);
  await workspace.write("index.html", Buffer.from("broken document"));

  await recoverWorkspace(workspace, templateDir, { restore: revision, resetUI: true, log });

  assert.deepEqual(await workspace.read("index.html"), await readFile(path.join(templateDir, "index.html")));
  const backup = await recoveryDirectory(workspace);
  assert.equal(await readFile(path.join(backup, "index.html"), "utf8"), savedHTML);
  await assert.rejects(access(path.join(backup, "outbox.jsonl")), { code: "ENOENT" });
});

test("reset UI refuses symlink helpers without reading or overwriting their targets", async t => {
  const { root, workspace, log } = await fixture(t);
  const outside = path.join(root, "private.txt");
  await writeFile(outside, "not a workspace resource");
  await rm(path.join(workspace.directory, "agent-output.js"));
  await symlink(outside, path.join(workspace.directory, "agent-output.js"));

  await assert.rejects(recoverWorkspace(workspace, templateDir, { resetUI: true, log }), StorageError);

  assert.equal(await readFile(outside, "utf8"), "not a workspace resource");
  const backup = await recoveryDirectory(workspace);
  await assert.rejects(access(path.join(backup, "agent-output.js")), { code: "ENOENT" });
  await assert.rejects(workspace.read("agent-output.js"), StorageError);
});
