import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { MAX_RESOURCE_BYTES, openWorkspace, StorageError } from "../src/storage.ts";
import { startServer } from "../src/server.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(settle => { resolve = settle; });
  return { promise, resolve };
}

async function fixture(downloadSource?: NonNullable<Parameters<typeof startServer>[1]>["downloadSource"]) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pagent-server-"));
  const templateDir = path.join(root, "template");
  await mkdir(templateDir);
  await writeFile(path.join(templateDir, "index.html"), '<!doctype html><p-agent id="main">workspace</p-agent>');
  await writeFile(path.join(templateDir, "agent.js"), "export const editable = true;");
  const workspace = await openWorkspace({ directory: path.join(root, "workspace"), templateDir });
  const server = await startServer(workspace, { port: 0, downloadSource });
  const url = new URL(server.url);
  return {
    root, workspace, server, url,
    async close() { await server.close(); await workspace.close(); await rm(root, { recursive: true, force: true }); },
    call(resource: string, options: { method?: string; headers?: Record<string, string | string[]>; body?: Buffer | string; host?: string } = {}) {
      return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: Buffer }>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: server.port, path: resource, method: options.method ?? "GET", headers: { Host: options.host ?? url.host, ...options.headers } }, response => {
          const chunks: Buffer[] = [];
          response.on("data", chunk => chunks.push(chunk));
          response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          response.once("error", reject);
        });
        req.once("error", reject);
        req.end(options.body);
      });
    },
  };
}

test("PUT preserves request bytes, DELETE removes only files, and GET/HEAD list public directories", async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from([0, 255, 13, 10, 128]);
    const headers = { Origin: f.url.origin };
    assert.equal((await f.call("/notes/raw.bin", { method: "PUT", headers, body: bytes })).status, 204);
    assert.deepEqual((await f.call("/notes/raw.bin")).body, bytes);
    assert.equal((await f.call("/notes/data.csv", { method: "PUT", headers, body: "a,b\n1,2\n" })).status, 204);
    assert.equal((await f.call("/notes/data.csv")).headers["content-type"], "text/csv; charset=utf-8");
    await f.workspace.write("notes/deep/note.txt", Buffer.from("nested"));
    await writeFile(path.join(f.workspace.directory, "notes", ".secret"), "hidden");
    await symlink(f.root, path.join(f.workspace.directory, "notes", "link"));
    const listing = await f.call("/notes/");
    assert.equal(listing.status, 200);
    assert.equal(listing.headers["content-type"], "application/json; charset=utf-8");
    assert.deepEqual(JSON.parse(listing.body.toString()), [
      { name: "data.csv", type: "file", size: 8 },
      { name: "deep", type: "directory" },
      { name: "raw.bin", type: "file", size: 5 },
    ]);
    const head = await f.call("/notes/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers["content-length"]), listing.body.length);
    assert.equal(head.body.length, 0);
    const root = await f.call("/?list");
    assert.deepEqual(JSON.parse(root.body.toString()).map((entry: { name: string }) => entry.name), ["agent.js", "index.html", "notes"]);
    const rootHead = await f.call("/?list", { method: "HEAD" });
    assert.equal(Number(rootHead.headers["content-length"]), root.body.length);
    assert.equal(rootHead.body.length, 0);
    assert.match((await f.call("/")).body.toString(), /workspace/);
    assert.equal((await f.call("/missing/")).status, 404);
    for (const resource of ["/", "/?list", "/notes", "/notes/", "/notes/link", "/notes/link/template/index.html", "/notes/.secret"]) {
      assert.equal((await f.call(resource, { method: "DELETE", headers })).status, 403, resource);
    }
    assert.equal((await f.call("/notes/raw.bin", { method: "DELETE", headers })).status, 204);
    assert.equal((await f.call("/notes/raw.bin")).status, 404);
    assert.equal((await f.call("/notes/raw.bin", { method: "DELETE", headers })).status, 404);
    assert.equal((await f.call("/notes/raw.bin", { method: "PUT", headers })).status, 204);
    assert.equal((await f.call("/notes/raw.bin")).body.length, 0);
    assert.equal((await f.call("/", { method: "PUT", headers, body: "replacement root" })).status, 204);
    assert.equal((await f.call("/")).body.toString(), "replacement root");
  } finally { await f.close(); }
});

test("PUT and DELETE enforce origins, exact host, traversal, symlink and body-size protections", async () => {
  const f = await fixture();
  try {
    for (const method of ["PUT", "DELETE"]) {
      for (const origin of [undefined, "", "null", "https://evil.test", `http://sibling.aos.localhost:${f.server.port}`]) {
        assert.equal((await f.call("/index.html", { method, headers: origin === undefined ? {} : { Origin: origin } })).status, 403);
      }
      for (const site of ["cross-site", "same-site"]) {
        assert.equal((await f.call("/index.html", { method, headers: { Origin: f.url.origin, "Sec-Fetch-Site": site } })).status, 403);
      }
      assert.equal((await f.call("/index.html", { method, host: `unknown.aos.localhost:${f.server.port}`, headers: { Origin: f.url.origin } })).status, 403);
      for (const resource of ["/../index.html", "/%2e%2e/index.html", "/.pagent/host.lock", "/a%2fb", "/a//b"]) {
        assert.ok([400, 403].includes((await f.call(resource, { method, headers: { Origin: f.url.origin } })).status));
      }
    }
    await symlink(f.root, path.join(f.workspace.directory, "link"));
    for (const method of ["PUT", "DELETE"]) {
      assert.equal((await f.call("/link/template/index.html", { method, headers: { Origin: f.url.origin } })).status, 403);
    }
    for (const [name, value] of [["Content-Length", String(MAX_RESOURCE_BYTES + 1)], ["Transfer-Encoding", "chunked"]]) {
      const response = await f.call("/index.html", { method: "PUT", headers: { Origin: f.url.origin, [name]: value }, body: name === "Transfer-Encoding" ? Buffer.alloc(MAX_RESOURCE_BYTES + 1) : undefined });
      assert.equal(response.status, 413);
    }
    assert.match((await f.call("/")).body.toString(), /workspace/);
  } finally { await f.close(); }
});

test("Source PUT stores exact downloaded bytes and passes only the URL and abort signal", async () => {
  const bytes = Buffer.from([0, 255, 128, 10, 13, 60, 62]);
  let calls = 0;
  const f = await fixture(async (url, options) => {
    calls++;
    assert.equal(url, "https://public.example/data.csv?raw=1");
    assert.deepEqual(Object.keys(options ?? {}), ["signal"]);
    assert.ok(options?.signal instanceof AbortSignal);
    assert.equal(options.signal.aborted, false);
    return bytes;
  });
  try {
    const response = await f.call("/notes/data.csv", { method: "PUT", headers: {
      Origin: f.url.origin, Source: "https://public.example/data.csv?raw=1", Cookie: "secret=cookie",
      Authorization: "Bearer secret", "Content-Type": "application/json", "X-Custom": "not forwarded",
    } });
    assert.equal(response.status, 204);
    assert.equal(calls, 1);
    assert.deepEqual((await f.call("/notes/data.csv")).body, bytes);
    assert.equal((await f.call("/notes/data.csv")).headers["content-type"], "text/csv; charset=utf-8");
    assert.match((await f.call("/")).body.toString(), /workspace/);
  } finally { await f.close(); }
});

test("Source download failures and oversized results never replace existing files", async () => {
  let failure: Error | undefined = new Error("upstream unavailable");
  const f = await fixture(async () => {
    if (failure) throw failure;
    return Buffer.alloc(MAX_RESOURCE_BYTES + 1);
  });
  try {
    for (const [error, expected] of [[failure, 502], [new StorageError(504, "Source timed out."), 504], [new StorageError(413, "Source exceeds 16 MiB."), 413], [undefined, 413]] as const) {
      failure = error;
      const response = await f.call("/index.html", { method: "PUT", headers: { Origin: f.url.origin, Source: "https://public.example/data" } });
      assert.equal(response.status, expected);
      assert.match((await f.call("/")).body.toString(), /workspace/);
    }
  } finally { await f.close(); }
});

test("real Source downloader rejects private and invalid URLs without replacing resources", async () => {
  const f = await fixture();
  try {
    for (const [source, status] of [["http://127.0.0.1/secret", 403], ["http://localhost/secret", 403], ["http://192.168.1.1/secret", 403], ["file:///etc/passwd", 400], ["not-a-url", 400]] as const) {
      const response = await f.call("/index.html", { method: "PUT", headers: { Origin: f.url.origin, Source: source } });
      assert.equal(response.status, status, source);
      assert.match((await f.call("/")).body.toString(), /workspace/);
    }
  } finally { await f.close(); }
});

test("Source rejects methods, duplicate headers, nonempty bodies, paths, hosts and origins before downloading", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return Buffer.from("must not write"); });
  try {
    const headers = { Origin: f.url.origin, Source: "https://public.example/data" };
    for (const method of ["GET", "HEAD", "POST", "DELETE", "OPTIONS", "PATCH"]) {
      assert.equal((await f.call("/index.html", { method, headers })).status, 400, method);
    }
    assert.equal((await f.call("/index.html", { method: "PUT", headers: { ...headers, Source: [headers.Source, headers.Source] } })).status, 400);
    assert.equal((await f.call("/index.html", { method: "PUT", headers: { ...headers, Source: "" } })).status, 400);
    for (const [name, value] of [["Content-Length", "1"], ["Transfer-Encoding", "chunked"]]) {
      assert.equal((await f.call("/index.html", { method: "PUT", headers: { ...headers, [name]: value }, body: "x" })).status, 400);
    }
    for (const origin of [undefined, "", "null", "https://evil.test", `http://sibling.aos.localhost:${f.server.port}`]) {
      assert.equal((await f.call("/index.html", { method: "PUT", headers: origin === undefined ? { Source: headers.Source } : { ...headers, Origin: origin } })).status, 403);
    }
    for (const site of ["cross-site", "same-site"]) {
      assert.equal((await f.call("/index.html", { method: "PUT", headers: { ...headers, "Sec-Fetch-Site": site } })).status, 403);
    }
    assert.equal((await f.call("/index.html", { method: "PUT", host: "unknown.aos.localhost", headers })).status, 403);
    assert.equal((await f.call("/../index.html", { method: "PUT", headers })).status, 403);
    assert.equal(calls, 0);
    assert.match((await f.workspace.read("/")).toString(), /workspace/);
  } finally { await f.close(); }
});

test("shutdown rejects a late Source result even if the downloader ignores cancellation", async () => {
  const started = deferred<AbortSignal>();
  const downloaded = deferred<Buffer>();
  const f = await fixture(async (_url, options) => {
    started.resolve(options!.signal!);
    return downloaded.promise;
  });
  try {
    const response = f.call("/index.html", { method: "PUT", headers: { Origin: f.url.origin, Source: "https://public.example/data" } });
    const rejected = assert.rejects(response, /socket hang up|ECONNRESET/);
    const signal = await started.promise;
    const closing = f.server.close();
    assert.equal(signal.aborted, true);
    downloaded.resolve(Buffer.from("late result"));
    await closing;
    await rejected;
    assert.match((await f.workspace.read("/")).toString(), /workspace/);
  } finally { downloaded.resolve(Buffer.from("late result")); await f.close(); }
});

test("disconnect and server close abort Source downloads and settle before clean shutdown", async () => {
  for (const action of ["disconnect", "close"] as const) {
    const started = deferred<AbortSignal>();
    const cancelled = deferred<void>();
    const f = await fixture(async (_url, options) => {
      const signal = options!.signal!;
      started.resolve(signal);
      return new Promise<Buffer>((_resolve, reject) => signal.addEventListener("abort", () => {
        cancelled.resolve();
        reject(signal.reason);
      }, { once: true }));
    });
    try {
      const req = request({ hostname: "127.0.0.1", port: f.server.port, path: "/index.html", method: "PUT", headers: { Host: f.url.host, Origin: f.url.origin, Source: "https://public.example/data" } });
      req.on("error", () => {});
      req.end();
      const signal = await started.promise;
      if (action === "disconnect") req.destroy();
      else await f.server.close();
      await cancelled.promise;
      assert.equal(signal.aborted, true);
      await f.server.close();
      assert.match((await f.workspace.read("/")).toString(), /workspace/);
    } finally { await f.close(); }
  }
});

test("serves exact-origin GET/HEAD and atomic storage-only POST with correct content types", async () => {
  const f = await fixture();
  try {
    assert.equal(f.server.url, `http://127.0.0.1:${f.server.port}/`);
    const root = await f.call("/");
    assert.equal(root.status, 200);
    assert.match(String(root.headers["content-type"]), /text\/html/);
    assert.equal(root.headers["cache-control"], "no-store");
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["cross-origin-resource-policy"], "same-origin");
    const head = await f.call("/", { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(Number(head.headers["content-length"]), root.body.length);
    assert.equal(head.body.length, 0);
    assert.match(String((await f.call("/agent.js?version=2")).headers["content-type"]), /javascript/);
    const post = await f.call("/research/info.html", { method: "POST", headers: { Origin: f.url.origin, "Content-Type": "text/html", "Sec-Fetch-Site": "same-origin" }, body: "<h1>Saved notes</h1>" });
    assert.equal(post.status, 204);
    assert.equal((await f.call("/research/info.html")).body.toString(), "<h1>Saved notes</h1>");
    assert.equal((await f.call("/")).body.toString(), root.body.toString(), "POST to another resource must not replace root");
    assert.equal((await f.call("/", { method: "POST", headers: { Origin: f.url.origin }, body: "new root" })).status, 204);
    assert.equal((await f.call("/index.html")).body.toString(), "new root");
    assert.equal((await f.call("/state.json", { method: "POST", headers: { Origin: f.url.origin }, body: "{}" })).status, 204);
    assert.match(String((await f.call("/state.json")).headers["content-type"]), /application\/json/);
    await f.workspace.write("program.wasm", Buffer.from([0, 97, 115, 109]));
    assert.equal((await f.call("/program.wasm")).headers["content-type"], "application/wasm");
  } finally { await f.close(); }
});

test("rejects foreign hosts/origins, missing write origin, cross-site and same-site writes", async () => {
  const f = await fixture();
  try {
    for (const host of ["evil.test", `other.aos.localhost:${f.server.port}`, "127.0.0.1", "example.aos.localhost", `${f.url.host}.evil.test`]) {
      assert.equal((await f.call("/", { host })).status, 403, host);
    }
    for (const origin of ["", "null", "https://evil.test", `http://other.aos.localhost:${f.server.port}`, "http://example.aos.localhost"]) {
      const result = await f.call("/", { headers: { Origin: origin } });
      assert.equal(result.status, 403, origin);
      assert.equal(result.headers["access-control-allow-origin"], undefined);
      assert.equal((await f.call("/", { method: "POST", headers: { Origin: origin }, body: "bad" })).status, 403);
    }
    assert.equal((await f.call("/", { method: "POST", body: "bad" })).status, 403);
    for (const site of ["cross-site", "same-site"]) {
      assert.equal((await f.call("/", { method: "POST", headers: { Origin: f.url.origin, "Sec-Fetch-Site": site }, body: "bad" })).status, 403);
    }
    assert.match((await f.call("/")).body.toString(), /workspace/);
  } finally { await f.close(); }
});

test("validates raw paths before normalization, hides private state, and never follows symlinks", async () => {
  const f = await fixture();
  try {
    await writeFile(path.join(f.root, "secret"), "outside secret");
    await symlink(path.join(f.root, "secret"), path.join(f.workspace.directory, "secret"));
    for (const resource of ["/../index.html", "/a/../index.html", "/%2e%2e/index.html", "/%252e%252e/index.html", "/a%2f..%2findex.html", "/%5csecret", "/.pagent/host.lock", "/.hidden", "/secret", "/%00", "/%zz"]) {
      const response = await f.call(resource);
      assert.ok([400, 403].includes(response.status), `${resource}: ${response.status}`);
      assert.ok(!response.body.toString().includes(f.root));
      const post = await f.call(resource, { method: "POST", headers: { Origin: f.url.origin }, body: "bad" });
      assert.ok([400, 403].includes(post.status), `${resource}: ${post.status}`);
    }
    assert.equal((await f.call("/missing")).status, 404);
    assert.equal((await f.call("/missing", { method: "HEAD" })).body.length, 0);
    const unsupported = await f.call("/", { method: "PATCH" });
    assert.equal(unsupported.status, 405);
    assert.equal(unsupported.headers.allow, "GET, HEAD, POST, PUT, DELETE");
    assert.equal(await f.workspace.read("/agent.js").then(buffer => buffer.toString()), "export const editable = true;");
  } finally { await f.close(); }
});

test("rejects duplicate Host headers even when both match the listener", async () => {
  const f = await fixture();
  try {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ hostname: "127.0.0.1", port: f.server.port, path: "/", headers: ["Host", f.url.host, "Host", f.url.host] }, response => {
        response.resume();
        response.once("end", () => resolve(response.statusCode ?? 0));
        response.once("error", reject);
      });
      req.once("error", reject);
      req.end();
    });
    assert.equal(status, 403);
  } finally { await f.close(); }
});

test("enforces both declared and streamed body limits without modifying resources", async () => {
  const f = await fixture();
  try {
    const declared = await f.call("/", { method: "POST", headers: { Origin: f.url.origin, "Content-Length": String(MAX_RESOURCE_BYTES + 1) } });
    assert.equal(declared.status, 413);
    const streamed = await f.call("/", { method: "POST", headers: { Origin: f.url.origin, "Transfer-Encoding": "chunked" }, body: Buffer.alloc(MAX_RESOURCE_BYTES + 1, "x") });
    assert.equal(streamed.status, 413);
    assert.match((await f.call("/")).body.toString(), /workspace/);
  } finally { await f.close(); }
});
