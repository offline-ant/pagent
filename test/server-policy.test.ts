import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startServer } from "../src/server.ts";
import { openWorkspace } from "../src/storage.ts";

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "pagent-http-policy-"));
  const templateDir = path.join(root, "template");
  await mkdir(templateDir);
  await writeFile(path.join(templateDir, "index.html"), '<!doctype html><p-agent id="main">original</p-agent>');
  await writeFile(path.join(templateDir, "prompt.md"), "Do something.");
  const workspace = await openWorkspace({ directory: path.join(root, "workspace"), templateDir });
  return { workspace, async close() { await workspace.close(); await rm(root, { recursive: true, force: true }); } };
}

test("GET policy includes HEAD/listings, blocks mutations and keeps private checkpoints out of public files", async () => {
  const f = await fixture();
  let downloads = 0;
  const server = await startServer(f.workspace, { http: ["GET"], network: "local", downloadSource: async () => { downloads++; return Buffer.from("external"); } });
  try {
    const response = await fetch(server.url);
    const original = await response.text();
    assert.match(response.headers.get("content-security-policy") ?? "", /connect-src 'self'/);
    assert.doesNotMatch(response.headers.get("content-security-policy") ?? "", /unsafe-eval/);
    assert.equal((await fetch(server.url, { method: "HEAD" })).status, 200);
    assert.deepEqual((await (await fetch(server.url + "?list")).json() as { name: string }[]).map(entry => entry.name), ["index.html", "prompt.md"]);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const result = await fetch(server.url + "prompt.md", { method, headers: { Origin: new URL(server.url).origin } });
      assert.equal(result.status, 405, method);
      assert.equal(result.headers.get("allow"), "GET, HEAD");
    }
    assert.equal((await fetch(server.url + "prompt.md", { method: "PUT", headers: { Origin: new URL(server.url).origin, Source: "https://outside.example/file" } })).status, 405);
    assert.equal(downloads, 0);
    const revision = await f.workspace.checkpointPrivate('<p-agent id="main">changed DOM</p-agent>');
    assert.equal(await (await fetch(server.url)).text(), original);
    assert.match(await readFile(path.join(f.workspace.stateDirectory, "revisions", revision), "utf8"), /changed DOM/);
    assert.equal((await fetch(server.url + ".pagent/revisions/" + revision)).status, 403);
    await assert.rejects(f.workspace.checkpointPrivate("x".repeat(16 * 1024 * 1024 + 1)), /16 MiB/);
  } finally { await server.close(); await f.close(); }
});

test("local policy rejects Source even with PUT, while ordinary local writes remain configurable", async () => {
  const f = await fixture();
  let downloads = 0;
  const server = await startServer(f.workspace, { http: ["GET", "PUT"], network: "local", downloadSource: async () => { downloads++; return Buffer.from("external"); } });
  const headers = { Origin: new URL(server.url).origin };
  try {
    assert.equal((await fetch(server.url + "prompt.md", { method: "PUT", headers: { ...headers, Source: "https://outside.example/file" } })).status, 403);
    assert.equal(downloads, 0);
    assert.equal((await fetch(server.url + "prompt.md", { method: "PUT", headers, body: "local" })).status, 204);
    assert.equal(await (await fetch(server.url + "prompt.md")).text(), "local");
  } finally { await server.close(); await f.close(); }
});

test("HTTP method configuration is validated before opening a listener", async () => {
  const f = await fixture();
  try {
    for (const http of [["get"], ["GET", "GET"], ["OPTIONS"], ["FETCH"], [""]]) {
      await assert.rejects(startServer(f.workspace, { http }), /HTTP methods/);
    }
    const server = await startServer(f.workspace, { http: [] });
    try { assert.equal((await fetch(server.url)).status, 405); }
    finally { await server.close(); }
  } finally { await f.close(); }
});
