import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { downloadSource } from "./source.ts";
import { LOCAL_CONTENT_POLICY, validateBrowserPolicy } from "./browser-policy.ts";
import { MAX_RESOURCE_BYTES, resourcePath, StorageError, type Workspace } from "./storage.ts";

export interface ResourceServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8", ".md": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
  ".wasm": "application/wasm", ".pdf": "application/pdf", ".woff2": "font/woff2",
};

function respond(response: ServerResponse, status: number, message: string, head = false): void {
  response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Content-Length": Buffer.byteLength(message) });
  response.end(head ? undefined : message);
}

async function body(request: IncomingMessage, signal: AbortSignal, empty: boolean): Promise<Buffer> {
  signal.throwIfAborted();
  const limit = empty ? 0 : MAX_RESOURCE_BYTES;
  const tooLarge = () => new StorageError(empty ? 400 : 413, empty ? "Source PUT requires an empty request body." : "Resource exceeds 16 MiB.");
  const length = request.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) throw tooLarge();
  const chunks: Buffer[] = [];
  let size = 0;
  // Do not use async iteration: leaving it early destroys the request before an error can be sent.
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      request.off("data", data);
      request.off("end", end);
      request.off("aborted", aborted);
      request.off("error", failed);
      signal.removeEventListener("abort", cancelled);
    };
    const failed = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        failed(tooLarge());
        request.resume();
      } else chunks.push(chunk);
    };
    const end = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, size));
    };
    const aborted = () => failed(new StorageError(400, "Incomplete request body."));
    const cancelled = () => failed(signal.reason);
    const timer = setTimeout(() => failed(new StorageError(408, "Request body timed out.")), 30_000);
    request.on("data", data);
    request.once("end", end);
    request.once("aborted", aborted);
    request.once("error", failed);
    signal.addEventListener("abort", cancelled, { once: true });
  });
}

export async function startServer(workspace: Workspace, options: {
  port?: number;
  downloadSource?: typeof downloadSource;
  http?: string[];
  network?: "open" | "local";
} = {}): Promise<ResourceServer> {
  validateBrowserPolicy(options);
  const supported = ["GET", "HEAD", "POST", "PUT", "DELETE"];
  if (options.http !== undefined && (!Array.isArray(options.http) || options.http.some(method => !supported.includes(method)) || new Set(options.http).size !== options.http.length)) {
    throw new Error("HTTP methods must be unique values from GET, HEAD, POST, PUT, DELETE.");
  }
  const allowed = new Set(options.http ?? supported);
  if (allowed.has("GET")) allowed.add("HEAD");
  const allowHeader = supported.filter(method => allowed.has(method)).join(", ");
  const requestedPort = options.port ?? 0;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) throw new Error("Port must be an integer from 0 to 65535.");
  const fetchSource = options.downloadSource ?? downloadSource;
  const lifetime = new AbortController();
  let authority = "";
  const pending = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    response.setHeader("Referrer-Policy", "no-referrer");
    if (options.network === "local") {
      response.setHeader("Content-Security-Policy", LOCAL_CONTENT_POLICY);
      response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
    }
    const client = new AbortController();
    const disconnect = () => client.abort(new StorageError(400, "Client disconnected."));
    response.once("close", disconnect);
    const operation = (async () => {
      const head = request.method === "HEAD";
      const countHeader = (name: string) => request.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === name).length;
      if (countHeader("host") !== 1 || request.headers.host !== authority) throw new StorageError(403, "Host is not allowed.");
      const signal = AbortSignal.any([lifetime.signal, client.signal]);
      const origin = `http://${authority}`;
      if (request.headers.origin !== undefined && request.headers.origin !== origin) throw new StorageError(403, "Origin is not allowed.");
      const sourceCount = countHeader("source");
      if (sourceCount > 1) throw new StorageError(400, "Only one Source header is allowed.");
      if (sourceCount && request.method !== "PUT") throw new StorageError(400, "Source is only allowed on PUT.");
      const source = request.headers.source;
      if (sourceCount && (typeof source !== "string" || !source.trim())) throw new StorageError(400, "Source must be a public HTTP(S) URL.");
      if (!allowed.has(request.method ?? "")) {
        response.setHeader("Allow", allowHeader);
        throw new StorageError(405, "Method not allowed.");
      }
      if (sourceCount && options.network === "local") throw new StorageError(403, "Source downloads are disabled by the local network policy.");
      if (!request.url?.startsWith("/")) throw new StorageError(400, "Invalid request target.");
      // Preserve raw path spelling; new URL() would normalize literal dot segments away.
      const queryAt = request.url.indexOf("?");
      const resource = queryAt < 0 ? request.url : request.url.slice(0, queryAt);
      if (request.method === "GET" || head) {
        const listing = (resource !== "/" && resource.endsWith("/")) || (resource === "/" && new URLSearchParams(queryAt < 0 ? "" : request.url.slice(queryAt + 1)).has("list"));
        const relative = resourcePath(resource, listing);
        const bytes = listing ? Buffer.from(JSON.stringify(await workspace.list(resource))) : await workspace.read(resource);
        if (bytes.length > MAX_RESOURCE_BYTES) throw new StorageError(413, "Resource exceeds 16 MiB.");
        signal.throwIfAborted();
        response.writeHead(200, { "Content-Type": listing ? MIME[".json"] : MIME[path.extname(relative).toLowerCase()] ?? "application/octet-stream", "Content-Length": bytes.length });
        response.end(head ? undefined : bytes);
      } else if (request.method === "POST" || request.method === "PUT" || request.method === "DELETE") {
        if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site" || request.headers["sec-fetch-site"] === "same-site") {
          throw new StorageError(403, "Writes require the workspace's own origin.");
        }
        resourcePath(resource);
        if (request.method === "DELETE") {
          request.resume();
          signal.throwIfAborted();
          await workspace.remove(resource, { signal });
        } else {
          let bytes = await body(request, signal, sourceCount > 0);
          signal.throwIfAborted();
          if (typeof source === "string") {
            // The downloader owns its network deadline, independently of the completed request body.
            request.setTimeout(0);
            try { bytes = await fetchSource(source, { signal }); }
            catch (error) {
              signal.throwIfAborted();
              if (error instanceof StorageError) throw error;
              throw new StorageError(502, `Source download failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            signal.throwIfAborted();
          }
          await workspace.write(resource, bytes, { signal });
        }
        response.writeHead(204);
        response.end();
      } else {
        response.setHeader("Allow", allowHeader);
        throw new StorageError(405, "Method not allowed.");
      }
    })().catch((error: unknown) => {
      if (response.headersSent || response.destroyed) { response.destroy(); return; }
      let status = 500;
      let message = "Resource operation failed.";
      if (error instanceof StorageError) { status = error.status; message = error.message; }
      else if (error instanceof Error && "code" in error) {
        if (error.code === "ENOENT") { status = 404; message = "Resource not found."; }
        if (error.code === "EACCES" || error.code === "ELOOP" || error.code === "ENOTDIR") { status = 403; message = "Resource is not allowed."; }
        if (error.code === "ENOSPC" || error.code === "EDQUOT") { status = 507; message = "Insufficient resource storage."; }
      }
      // Rejected requests with unread bodies should not occupy a persistent connection.
      response.setHeader("Connection", "close");
      respond(response, status, message, request.method === "HEAD");
      request.resume();
    }).finally(() => {
      response.off("close", disconnect);
      pending.delete(operation);
    });
    pending.add(operation);
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.setTimeout(30_000, socket => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Could not determine HTTP listener address."); }
  const port = address.port;
  let closing: Promise<void> | undefined;
  authority = `127.0.0.1${port === 80 ? "" : `:${port}`}`;
  return {
    url: `http://${authority}/`, port,
    close() {
      lifetime.abort(new StorageError(403, "Workspace is no longer served."));
      closing ??= (async () => {
        const stopped = new Promise<void>((resolve, reject) => {
          server.close(error => error ? reject(error) : resolve());
          server.closeAllConnections();
        });
        await Promise.all([stopped, ...pending]);
      })();
      return closing;
    },
  };
}
