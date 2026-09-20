import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_RESOURCE_BYTES, openWorkspace, resourcePath, StorageError } from "../src/storage.ts";

const starter = '<!doctype html><p-agent id="main">starter</p-agent>';
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pagent-storage-"));
  const templateDir = path.join(root, "template");
  await mkdir(templateDir);
  await writeFile(path.join(templateDir, "index.html"), starter);
  await writeFile(path.join(templateDir, "agent.js"), "console.log('starter');");
  return { root, options: { directory: path.join(root, "My workspace"), templateDir } };
}

test("lists sorted public files and directories without following symlinks or exposing hidden paths", async () => {
  const { root, options } = await fixture();
  const workspace = await openWorkspace(options);
  try {
    await workspace.write("notes/z.csv", Buffer.from("a,b\n1,2\n"));
    await workspace.write("notes/café.txt", Buffer.from("note"));
    await workspace.write("notes/deep/data.bin", Buffer.from([0, 255]));
    await writeFile(path.join(workspace.directory, "notes", ".private"), "secret");
    await writeFile(path.join(workspace.directory, "notes", "invalid%name"), "secret");
    await mkdir(path.join(workspace.directory, "notes", ".state"));
    await symlink(root, path.join(workspace.directory, "notes", "linkdir"));
    await symlink(path.join(root, "missing"), path.join(workspace.directory, "notes", "broken"));
    await symlink(path.join(workspace.directory, "index.html"), path.join(workspace.directory, "notes", "linkfile"));
    const expected = [{ name: "café.txt", type: "file", size: 4 }, { name: "deep", type: "directory" }, { name: "z.csv", type: "file", size: 8 }];
    assert.deepEqual(await workspace.list("/notes/"), expected);
    assert.deepEqual(await workspace.list("notes"), expected);
    assert.deepEqual(await workspace.list("notes/deep/"), [{ name: "data.bin", type: "file", size: 2 }]);
    assert.deepEqual((await workspace.list("/")).map(entry => entry.name), ["agent.js", "index.html", "notes"]);
    assert.deepEqual(await workspace.list(""), await workspace.list("/"));
    for (const resource of ["//", "/notes//", "/notes/../", "/%2e%2e/", "/notes/.state/", "/notes/linkdir/", "/.pagent/"]) {
      await assert.rejects(workspace.list(resource), StorageError, resource);
    }
    await assert.rejects(workspace.list("missing/"), { code: "ENOENT" });
    await assert.rejects(workspace.list("index.html/"), StorageError);
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("removes files only and serializes deletion with writes, listings, and close", async () => {
  const { root, options } = await fixture();
  const workspace = await openWorkspace(options);
  try {
    await workspace.write("notes/data.txt", Buffer.from("keep"));
    await workspace.checkpoint(starter);
    await symlink(root, path.join(workspace.directory, "linked"));
    for (const resource of ["", "/", "notes", "notes/", "linked", "linked/template/index.html", "/../secret", "/.pagent/host.lock"]) {
      await assert.rejects(workspace.remove(resource), StorageError, resource);
    }
    await assert.rejects(workspace.remove("missing"), { code: "ENOENT" });
    assert.equal((await workspace.read("notes/data.txt")).toString(), "keep");
    await rm(path.join(workspace.directory, "linked"));
    const write = workspace.write("notes/data.txt", Buffer.from("before delete"));
    const remove = workspace.remove("notes/data.txt");
    const listing = workspace.list("notes/");
    const rewrite = workspace.write("notes/data.txt", Buffer.from("after delete"));
    const closing = workspace.close();
    await Promise.all([write, remove, rewrite, closing]);
    assert.deepEqual(await listing, []);
    assert.equal(await readFile(path.join(workspace.directory, "notes/data.txt"), "utf8"), "after delete");
    await assert.rejects(workspace.remove("notes/data.txt"), /closed/);
    await assert.rejects(workspace.list("/"), /closed/);
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("aborted queued mutations leave existing bytes unchanged", async () => {
  const { root, options } = await fixture();
  const workspace = await openWorkspace(options);
  try {
    await workspace.write("data", Buffer.from("original"));
    const controller = new AbortController();
    const writing = workspace.write("data", Buffer.from("replacement"), { signal: controller.signal });
    const removing = workspace.remove("data", { signal: controller.signal });
    controller.abort(new Error("server stopped"));
    await assert.rejects(writing, /server stopped/);
    await assert.rejects(removing, /server stopped/);
    assert.equal((await workspace.read("data")).toString(), "original");
    assert.ok(!(await readdir(workspace.directory)).some(name => name.startsWith(".pagent-write-")));
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("seeds once, preserves edited files, serializes atomic writes, and checkpoints revisions", async () => {
  const { root, options } = await fixture();
  let workspace = await openWorkspace(options);
  try {
    assert.equal(workspace.directory, options.directory);
    assert.equal(workspace.stateDirectory, path.join(options.directory, ".pagent"));
    assert.match((await workspace.read("/")).toString(), /starter/);
    await workspace.write("/research/info.html", Buffer.from("notes"));
    await workspace.write("/agent.js", Buffer.from("edited"));
    const saved = '<!doctype html><p-agent id="main">saved</p-agent>';
    const revision = await workspace.checkpoint(saved);
    assert.equal((await workspace.read("/index.html")).toString(), saved);
    assert.equal(await readFile(path.join(workspace.stateDirectory, "revisions", revision), "utf8"), saved);
    const revisions = await Promise.all([workspace.checkpoint(starter), workspace.checkpoint(saved)]);
    assert.notEqual(revisions[0], revisions[1]);
    assert.equal((await workspace.read("/")).toString(), saved);
    await workspace.close();
    await writeFile(path.join(options.templateDir, "agent.js"), "new default");
    workspace = await openWorkspace(options);
    assert.equal((await workspace.read("agent.js")).toString(), "edited");
    assert.equal((await workspace.read("research/info.html")).toString(), "notes");
    const buffers = [Buffer.alloc(8192, "a"), Buffer.alloc(8192, "b")];
    await workspace.write("data.txt", buffers[0]);
    const writes = Promise.all(Array.from({ length: 8 }, (_value, i) => workspace.write("data.txt", buffers[i % 2])));
    for (let i = 0; i < 8; i++) {
      const observed = await workspace.read("data.txt");
      assert.ok(buffers.some(bytes => bytes.equals(observed)), "Reader saw a partial write");
    }
    await writes;
    assert.ok(!(await readdir(workspace.directory)).some(name => name.startsWith(".pagent-write-")));
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects traversal, hidden paths, encoded delimiters, symlinks, and oversize resources", async () => {
  const { root, options } = await fixture();
  const workspace = await openWorkspace(options);
  try {
    for (const resource of ["/../secret", "/a/../../secret", "/%2e%2e/secret", "/%252e%252e/secret", "/a%2fb", "/a%5cb", "/a\\b", "/.pagent/host.lock", "/a/.hidden", "//index.html", "/a//b", "/a/", "/%00", "/%", "/x?query", "/x#fragment"]) assert.throws(() => resourcePath(resource), StorageError, resource);
    await writeFile(path.join(root, "secret"), "private");
    await symlink(path.join(root, "secret"), path.join(workspace.directory, "link.txt"));
    await symlink(root, path.join(workspace.directory, "linkdir"));
    for (const resource of ["link.txt", "linkdir/secret", "linkdir/new.txt"]) {
      await assert.rejects(workspace.read(resource), StorageError);
      await assert.rejects(workspace.write(resource, Buffer.from("bad")), StorageError);
    }
    assert.equal(await readFile(path.join(root, "secret"), "utf8"), "private");
    await assert.rejects(workspace.write("large", Buffer.alloc(MAX_RESOURCE_BYTES + 1)), /16 MiB/);
    await writeFile(path.join(workspace.directory, "large"), Buffer.alloc(MAX_RESOURCE_BYTES + 1));
    await assert.rejects(workspace.read("large"), /16 MiB/);
    await assert.rejects(workspace.checkpoint("a".repeat(MAX_RESOURCE_BYTES + 1)), /16 MiB/);
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("rejects query/fragment delimiters without creating unlistable resources, and supports Unicode paths", async () => {
  const { root, options } = await fixture();
  const workspace = await openWorkspace(options);
  try {
    const initial = await workspace.list("/");
    for (const resource of ["a#b", "a?b", "a%23b", "a%3fb", "a%3Fb", "a%2523b", "a%253fb", "a%253Fb"]) {
      const invalidPath = { name: "StorageError", status: 400 };
      assert.throws(() => resourcePath(resource), invalidPath, resource);
      assert.throws(() => resourcePath(`${resource}/`, true), invalidPath, resource);
      await assert.rejects(workspace.write(resource, Buffer.from("must not be stored")), invalidPath, resource);
      await assert.rejects(workspace.read(resource), invalidPath, resource);
      await assert.rejects(workspace.list(`${resource}/`), invalidPath, resource);
      await assert.rejects(workspace.remove(resource), invalidPath, resource);
    }
    assert.deepEqual(await workspace.list("/"), initial);
    assert.deepEqual((await readdir(workspace.directory)).sort(), [".pagent", ...initial.map(entry => entry.name)]);
    const resource = "notes/日本語/café notes.txt";
    const encoded = "/notes/%E6%97%A5%E6%9C%AC%E8%AA%9E/caf%C3%A9%20notes.txt";
    assert.equal(resourcePath(encoded), resource);
    await workspace.write(encoded, Buffer.from("notes"));
    assert.equal((await workspace.read(resource)).toString(), "notes");
    assert.deepEqual(await workspace.list("notes/日本語/"), [{ name: "café notes.txt", type: "file", size: 5 }]);
    await workspace.remove(encoded);
    assert.deepEqual(await workspace.list("notes/日本語/"), []);
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("exclusive lock rejects live owners and close is idempotent", async () => {
  const { root, options } = await fixture();
  const workspace = await openWorkspace(options);
  try {
    await assert.rejects(openWorkspace(options), /already open/);
    await workspace.close();
    await workspace.close();
    await assert.rejects(workspace.read("/"), /closed/);
    await assert.rejects(workspace.write("x", Buffer.from("x")), /closed/);
    await assert.rejects(workspace.list("/"), /closed/);
    await assert.rejects(workspace.remove("agent.js"), /closed/);
    const reopened = await openWorkspace(options);
    await reopened.close();
  } finally { await workspace.close(); await rm(root, { recursive: true, force: true }); }
});

test("concurrent startups acquire exactly one exclusive lock", async () => {
  const { root, options } = await fixture();
  const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => openWorkspace(options)));
  const opened = attempts.filter(result => result.status === "fulfilled").map(result => result.value);
  try {
    assert.equal(opened.length, 1);
    for (const attempt of attempts) if (attempt.status === "rejected") assert.match(String(attempt.reason), /already open|incomplete|already exists/);
    const filename = path.join(opened[0].stateDirectory, "host.lock");
    const contents = await readFile(filename, "utf8");
    assert.equal((JSON.parse(contents) as { pid: number }).pid, process.pid);
    await assert.rejects(openWorkspace(options), /already open/);
    assert.equal(await readFile(filename, "utf8"), contents);
  } finally { await Promise.all(opened.map(workspace => workspace.close())); await rm(root, { recursive: true, force: true }); }
});

test("stale and incomplete locks are refused without modifying them", async () => {
  const { root, options } = await fixture();
  const stateDirectory = path.join(options.directory, ".pagent");
  const filename = path.join(stateDirectory, "host.lock");
  await mkdir(stateDirectory, { recursive: true });
  try {
    const stale = JSON.stringify({ pid: 2147483647, token: "dead-owner" });
    for (const contents of [stale, "", "not json"]) {
      await writeFile(filename, contents);
      const attempts = await Promise.allSettled(Array.from({ length: 12 }, () => openWorkspace(options)));
      for (const attempt of attempts) {
        assert.equal(attempt.status, "rejected");
        if (attempt.status !== "rejected") continue;
        assert.match(String(attempt.reason), contents === stale ? /Stale workspace lock for process 2147483647/ : /incomplete/);
        assert.ok(String(attempt.reason).includes(filename));
        assert.match(String(attempt.reason), /manually only after confirming/);
      }
      assert.equal(await readFile(filename, "utf8"), contents);
      await assert.rejects(access(path.join(options.directory, "index.html")), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("symlink roots and unsafe starter files are rejected before creating resources", async () => {
  const { root, options } = await fixture();
  try {
    await symlink(options.templateDir, path.join(root, "linked"));
    await assert.rejects(openWorkspace({ ...options, directory: path.join(root, "linked") }), StorageError);
    await symlink(path.join(root, "outside"), path.join(options.templateDir, "bad"));
    await assert.rejects(openWorkspace(options), /symlink/);
    await assert.rejects(access(options.directory), { code: "ENOENT" });
    await rm(path.join(options.templateDir, "bad"));
    const workspace = await openWorkspace(options);
    try { assert.match((await workspace.read("/")).toString(), /starter/); } finally { await workspace.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("missing index seeds an existing directory without touching unrelated files; collisions never overwrite", async () => {
  const { root, options } = await fixture();
  try {
    await mkdir(options.directory);
    await writeFile(path.join(options.directory, "notes.txt"), "keep notes");
    await writeFile(path.join(options.directory, "agent.js"), "keep script");
    await assert.rejects(openWorkspace(options), /agent.js already exists/);
    assert.deepEqual((await readdir(options.directory)).sort(), ["agent.js", "notes.txt"]);
    assert.equal(await readFile(path.join(options.directory, "agent.js"), "utf8"), "keep script");
    await rm(path.join(options.directory, "agent.js"));
    const workspace = await openWorkspace(options);
    try {
      assert.equal((await workspace.read("notes.txt")).toString(), "keep notes");
      assert.equal((await workspace.read("index.html")).toString(), starter);
    } finally { await workspace.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("existing HTML must contain a real static light-DOM HTML agent, with no mutations on rejection", async () => {
  const { root, options } = await fixture();
  await mkdir(options.directory);
  const filename = path.join(options.directory, "index.html");
  try {
    for (const html of ["plain text", "<!-- <p-agent> -->", '<script>const html = "<p-agent>";</script>', '<p title="<p-agent>">text</p>', '<template><p-agent></p-agent></template>', '<svg><p-agent></p-agent></svg>', '<textarea><p-agent></p-agent></textarea>', '&lt;p-agent&gt;']) {
      await writeFile(filename, html);
      await assert.rejects(openWorkspace(options), /Warning: index.html contains no static <p-agent>/);
      assert.equal(await readFile(filename, "utf8"), html);
      assert.deepEqual(await readdir(options.directory), ["index.html"]);
    }
    for (const html of ['<P-AGENT id="main"></P-AGENT>', '<div><p-agent id="main"></p-agent></div>']) {
      await writeFile(filename, html);
      const workspace = await openWorkspace(options);
      await workspace.close();
      assert.equal(await readFile(filename, "utf8"), html);
      await assert.rejects(access(path.join(options.directory, "agent.js")), { code: "ENOENT" });
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});
