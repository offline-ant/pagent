import assert from "node:assert/strict";
import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import http from "node:http";
import type { IncomingMessage, RequestOptions, ServerResponse } from "node:http";
import https from "node:https";
import type { RequestOptions as HttpsRequestOptions } from "node:https";
import { test } from "node:test";
import type { TestContext } from "node:test";
import { downloadSource } from "../src/source.ts";
import { MAX_RESOURCE_BYTES, StorageError } from "../src/storage.ts";

const PUBLIC_V4 = "93.184.215.14";
const PUBLIC_V6 = "2606:4700:4700::1111";

function status(expected: number, pattern?: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof StorageError);
    assert.equal(error.status, expected, error.message);
    if (pattern) assert.match(error.message, pattern);
    return true;
  };
}

// Test-only transport redirection. Production still validates the URL and every
// DNS answer; the real socket invokes its pinned lookup before we map that
// verified public result onto this disposable loopback fixture.
async function fixture(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const listening = server.address();
  assert.ok(listening && typeof listening !== "string");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  const calls: { url: URL; options: HttpsRequestOptions; pinned: string[] }[] = [];
  const nativeRequest = http.request;
  const transport = (url: URL, options: HttpsRequestOptions) => {
    const call = { url, options, pinned: [] as string[] };
    calls.push(call);
    assert.equal(options.agent, false);
    assert.equal(options.rejectUnauthorized, true);
    assert.deepEqual(options.headers, { "Accept-Encoding": "identity" });
    assert.ok(options.lookup);
    const local: RequestOptions = {
      ...options, protocol: "http:", hostname: "source.example", port: listening.port,
      path: url.pathname + url.search, family: 4,
      lookup: (hostname, lookupOptions, callback) => {
        options.lookup!(hostname, lookupOptions, (error, address, family) => {
          assert.equal(error, null);
          assert.equal(typeof address, "string");
          assert.equal(family, options.family);
          call.pinned.push(String(address));
          callback(null, "127.0.0.1", 4);
        });
      },
    };
    return nativeRequest(local);
  };
  t.mock.method(http, "request", transport);
  t.mock.method(https, "request", transport);
  const lookup = t.mock.method(dns, "lookup", async (_hostname: string): Promise<LookupAddress[]> => [{ address: PUBLIC_V4, family: 4 }]);
  return { calls, lookup };
}

test("downloads exact binary bytes with pinned DNS, original HTTPS host and no ambient headers", async t => {
  const bytes = Buffer.from([0, 255, 128, 13, 10, 0, 97]);
  const f = await fixture(t, (request, response) => {
    assert.equal(request.method, "GET");
    assert.equal(request.headers["accept-encoding"], "identity");
    assert.equal(request.headers.authorization, undefined);
    assert.equal(request.headers.cookie, undefined);
    assert.equal(request.headers.referer, undefined);
    response.end(bytes);
  });
  assert.deepEqual(await downloadSource("https://source.example/file.bin?token=secret"), bytes);
  assert.equal(f.lookup.mock.callCount(), 1, "socket must not perform a second DNS resolution");
  assert.deepEqual(f.lookup.mock.calls[0].arguments, ["source.example", { all: true, verbatim: true }]);
  assert.equal(f.calls[0].url.hostname, "source.example", "TLS retains the original hostname");
  assert.deepEqual(f.calls[0].pinned, [PUBLIC_V4]);
  const all = await new Promise<unknown>((resolve, reject) => f.calls[0].options.lookup!("source.example", { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses)));
  assert.deepEqual(all, [{ address: PUBLIC_V4, family: 4 }]);
});

test("rejects malformed URLs, credentials and fragments without DNS or connections", async t => {
  const f = await fixture(t, (_request, response) => response.end("unexpected"));
  for (const url of ["not a url", "/relative", "file:///etc/passwd", "ftp://source.example/file", "http://user:secret@source.example/", "http://source.example/#", "http://source.example/#fragment", "http://source.example/white space", "http://source.example/\\secret"]) {
    await assert.rejects(downloadSource(url), status(400));
  }
  for (const host of ["localhost", "LOCALHOST.", "nested.localhost", "local", "printer.local.", "router.home.arpa"]) {
    await assert.rejects(downloadSource(`http://${host}/`), status(403));
  }
  assert.equal(f.lookup.mock.callCount(), 0);
  assert.equal(f.calls.length, 0);
});

test("blocks nonpublic IPv4 and IPv6 literals including mapped, transition and documentation ranges", async t => {
  const f = await fixture(t, (_request, response) => response.end("public"));
  for (const host of [
    "0.0.0.0", "0.1.2.3", "10.1.2.3", "100.64.0.1", "100.127.255.255", "127.1", "2130706433", "0x7f000001",
    "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.0.0.9", "192.0.2.1", "192.88.99.1", "192.168.1.1",
    "198.18.0.1", "198.19.255.255", "198.51.100.2", "203.0.113.2", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255",
    "[::]", "[::1]", "[::127.0.0.1]", "[::ffff:127.0.0.1]", "[::ffff:8.8.8.8]", "[fc00::1]", "[fd00::1]", "[fe80::1]", "[fec0::1]", "[ff02::1]",
    "[64:ff9b::808:808]", "[64:ff9b:1::1]", "[100::1]", "[2001::1]", "[2001:2::1]", "[2001:10::1]", "[2001:db8::1]",
    "[2002:7f00:1::1]", "[3ffe::1]", "[3fff::1]", "[5f00::1]",
  ]) await assert.rejects(downloadSource(`http://${host}/`), status(403));
  assert.equal(f.lookup.mock.callCount(), 0);
  assert.equal(f.calls.length, 0);
  for (const host of ["8.8.8.8", "1.1.1.1", "100.63.255.255", "100.128.0.1", "172.15.255.255", "172.32.0.1", `[${PUBLIC_V6}]`]) {
    assert.equal((await downloadSource(`http://${host}/`)).toString(), "public");
  }
  assert.equal(f.lookup.mock.callCount(), 0, "IP literals do not use DNS");
});

test("checks every DNS answer and forbids mixed public/private results before connecting", async t => {
  const f = await fixture(t, (_request, response) => response.end("public"));
  for (const answers of [
    [], [{ address: "127.0.0.1", family: 4 }],
    [{ address: PUBLIC_V4, family: 4 }, { address: "10.0.0.1", family: 4 }],
    [{ address: PUBLIC_V4, family: 4 }, { address: "::ffff:127.0.0.1", family: 6 }],
    [{ address: PUBLIC_V6, family: 6 }, { address: "fe80::1%eth0", family: 6 }],
    [{ address: PUBLIC_V4, family: 6 }],
  ]) {
    f.lookup.mock.mockImplementation(async () => answers);
    await assert.rejects(downloadSource("http://source.example/"), status(403));
  }
  assert.equal(f.calls.length, 0);
  f.lookup.mock.mockImplementation(async () => [{ address: PUBLIC_V6, family: 6 }, { address: PUBLIC_V4, family: 4 }]);
  assert.equal((await downloadSource("http://source.example/")).toString(), "public");
  assert.deepEqual(f.calls[0].pinned, [PUBLIC_V6]);
});

test("redirects resolve and pin anew; private literal and rebinding answers never connect", async t => {
  let location = "/final";
  const f = await fixture(t, (request, response) => {
    if (request.url === "/start") response.writeHead(302, { Location: location }).end("not the resource");
    else response.end("final bytes");
  });
  assert.equal((await downloadSource("http://source.example/start")).toString(), "final bytes");
  assert.equal(f.lookup.mock.callCount(), 2);
  assert.deepEqual(f.calls.map(call => call.pinned), [[PUBLIC_V4], [PUBLIC_V4]]);
  location = "http://127.0.0.1/secret";
  await assert.rejects(downloadSource("http://source.example/start"), status(403));
  assert.equal(f.calls.length, 3);
  location = "http://other.example/secret";
  f.lookup.mock.mockImplementation(async (hostname: string) => [{ address: hostname === "other.example" ? "10.0.0.1" : PUBLIC_V4, family: 4 }]);
  await assert.rejects(downloadSource("http://source.example/start"), status(403));
  assert.equal(f.calls.length, 4);
  location = "/final";
  let resolutions = 0;
  f.lookup.mock.mockImplementation(async () => [{ address: resolutions++ === 0 ? PUBLIC_V4 : "127.0.0.1", family: 4 }]);
  await assert.rejects(downloadSource("http://source.example/start"), status(403));
  assert.equal(f.calls.length, 5, "same hostname must be revalidated on a redirect");
});

test("enforces redirect count and loop detection, and rejects unsafe redirect URLs", async t => {
  let location = "/loop";
  const f = await fixture(t, (request, response) => {
    if (location === "count") response.writeHead(307, { Location: `/${Number(request.url!.slice(1)) + 1}` }).end();
    else response.writeHead(301, { Location: location }).end();
  });
  await assert.rejects(downloadSource("http://source.example/loop"), status(502, /redirect.*loop/));
  assert.equal(f.calls.length, 1);
  location = "count";
  await assert.rejects(downloadSource("http://source.example/0"), status(502, /redirect/));
  assert.equal(f.calls.length, 7, "initial request plus five followed redirects");
  for (location of ["file:///etc/passwd", "http://user:secret@source.example/", "/foo#fragment"]) {
    await assert.rejects(downloadSource("http://source.example/0"), status(400));
  }
});

test("accepts five redirects, including each supported redirect status", async t => {
  const statuses = [301, 302, 303, 307, 308];
  const f = await fixture(t, (request, response) => {
    const step = Number(request.url!.slice(1));
    if (step < statuses.length) response.writeHead(statuses[step], { Location: `/${step + 1}` }).end("ignored redirect body");
    else response.end("complete");
  });
  assert.equal((await downloadSource("https://source.example/0")).toString(), "complete");
  assert.equal(f.calls.length, 6);
  assert.equal(f.lookup.mock.callCount(), 6);
});

test("rejects HTTP errors, compression and incomplete bodies without leaking source secrets", async t => {
  await fixture(t, (request, response) => {
    switch (request.url?.split("?")[0]) {
      case "/status": response.writeHead(404).end("private upstream diagnostic"); break;
      case "/redirect": response.writeHead(302).end("missing location"); break;
      case "/gzip": response.writeHead(200, { "Content-Encoding": "gzip" }).end("not decoded"); break;
      case "/truncated":
        response.writeHead(200, { "Content-Length": 99 });
        response.write("partial");
        setImmediate(() => response.destroy());
        break;
      default: response.end("complete");
    }
  });
  await assert.rejects(downloadSource("http://source.example/status?token=secret"), error => {
    status(502, /HTTP 404.*http:\/\/source.example/)(error);
    assert.doesNotMatch(String(error), /secret|private upstream|token/);
    return true;
  });
  for (const path of ["redirect", "gzip", "truncated"]) await assert.rejects(downloadSource(`http://source.example/${path}`), status(502));
  assert.equal((await downloadSource("http://source.example/ok")).toString(), "complete", "failures do not poison later downloads");
});

test("enforces declared and chunked limits while accepting exactly 16 MiB", async t => {
  await fixture(t, (request, response) => {
    if (request.url === "/declared") response.writeHead(200, { "Content-Length": MAX_RESOURCE_BYTES + 1 }).flushHeaders();
    else {
      response.writeHead(200, { "Transfer-Encoding": "chunked" });
      response.end(Buffer.alloc(request.url === "/large" ? MAX_RESOURCE_BYTES + 1 : MAX_RESOURCE_BYTES, 0xa5));
    }
  });
  await assert.rejects(downloadSource("http://source.example/declared"), status(413));
  await assert.rejects(downloadSource("http://source.example/large"), status(413));
  assert.deepEqual(await downloadSource("http://source.example/exact"), Buffer.alloc(MAX_RESOURCE_BYTES, 0xa5));
});

test("aborts before lookup and during DNS without later opening a socket", async t => {
  const f = await fixture(t, (_request, response) => response.end("unexpected"));
  await assert.rejects(downloadSource("http://source.example/", { signal: AbortSignal.abort() }), status(499));
  assert.equal(f.lookup.mock.callCount(), 0);
  let completeDns!: (addresses: { address: string; family: number }[]) => void;
  f.lookup.mock.mockImplementation(() => new Promise<LookupAddress[]>(resolve => { completeDns = resolve; }));
  const controller = new AbortController();
  const pending = downloadSource("http://source.example/", { signal: controller.signal });
  controller.abort(new Error("caller secret"));
  await assert.rejects(pending, status(499));
  completeDns([{ address: PUBLIC_V4, family: 4 }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});

test("abort destroys active requests and partial responses", async t => {
  let connected!: () => void;
  let closed!: () => void;
  await fixture(t, (request, response) => {
    response.once("close", () => closed());
    if (request.url === "/body") {
      response.writeHead(200);
      response.write("partial");
    }
    connected();
  });
  for (const path of ["headers", "body"]) {
    const ready = new Promise<void>(resolve => { connected = resolve; });
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const controller = new AbortController();
    const pending = downloadSource(`http://source.example/${path}`, { signal: controller.signal });
    const rejected = assert.rejects(pending, status(499));
    await ready;
    // Allow response headers/data to reach the client in the body case.
    await new Promise<void>(resolve => setImmediate(resolve));
    controller.abort();
    await rejected;
    await disconnected;
  }
});

test("total timeout covers stalled DNS and prevents a late connection", async t => {
  const f = await fixture(t, (_request, response) => response.end("unexpected"));
  let completeDns!: (addresses: { address: string; family: number }[]) => void;
  f.lookup.mock.mockImplementation(() => new Promise<LookupAddress[]>(resolve => { completeDns = resolve; }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = downloadSource("http://source.example/");
  const rejected = assert.rejects(pending, status(504));
  t.mock.timers.tick(20_000);
  await rejected;
  completeDns([{ address: PUBLIC_V4, family: 4 }]);
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});

test("total timeout spans redirects and destroys a stalled response", async t => {
  let ready!: () => void;
  let closed!: () => void;
  const received = new Promise<void>(resolve => { ready = resolve; });
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  await fixture(t, (request, response) => {
    if (request.url === "/start") {
      t.mock.timers.tick(12_000);
      response.writeHead(302, { Location: "/slow" }).end();
    } else {
      response.once("close", closed);
      response.write("partial");
      ready();
    }
  });
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = downloadSource("http://source.example/start");
  const rejected = assert.rejects(pending, status(504));
  await received;
  await new Promise<void>(resolve => setImmediate(resolve));
  t.mock.timers.tick(8_000);
  await rejected;
  await disconnected;
});

test("DNS and socket failures are useful but do not expose raw errors", async t => {
  const f = await fixture(t, (_request, response) => response.destroy());
  await assert.rejects(downloadSource("http://source.example/"), status(502, /connection failed/));
  f.lookup.mock.mockImplementation(async () => { throw new Error("resolver credential secret"); });
  await assert.rejects(downloadSource("http://source.example/?secret"), error => {
    status(502, /DNS lookup failed.*http:\/\/source.example/)(error);
    assert.doesNotMatch(String(error), /secret/);
    return true;
  });
});
