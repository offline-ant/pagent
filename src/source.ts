import dns from "node:dns/promises";
import http from "node:http";
import type { IncomingMessage } from "node:http";
import https from "node:https";
import type { RequestOptions } from "node:https";
import { BlockList, isIP } from "node:net";
import { MAX_RESOURCE_BYTES, StorageError } from "./storage.ts";

const TIMEOUT_MS = 20_000;
const MAX_REDIRECTS = 5;
const blocked = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(address, prefix, "ipv4");
// Only native global-unicast IPv6 is eligible. Exclude special-purpose,
// documentation and deprecated transition ranges even within 2000::/3.
const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
for (const [address, prefix] of [
  ["2001::", 23], ["2001:db8::", 32], ["2002::", 16], ["3ffe::", 16], ["3fff::", 20],
] as const) blocked.addSubnet(address, prefix, "ipv6");

function publicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  return family === 6 && !address.includes("%") && globalV6.check(address, "ipv6") && !blocked.check(address, "ipv6");
}

function sourceUrl(value: string, base?: URL): URL {
  let url: URL;
  try { url = new URL(value, base); }
  catch { throw new StorageError(400, "Source must be an absolute HTTP(S) URL."); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || value.includes("#") || /[\u0000-\u0020\u007f\\]/u.test(value)) {
    throw new StorageError(400, "Source must be an HTTP(S) URL without credentials, fragments, whitespace or backslashes.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  if (/^(?:localhost|local)$|\.(?:localhost|local)$/.test(hostname) || hostname === "home.arpa" || hostname.endsWith(".home.arpa")) {
    throw new StorageError(403, "Source hostname is not public.");
  }
  return url;
}

interface Address { address: string; family: number }

async function resolveSource(url: URL): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  let addresses: Address[];
  try {
    addresses = family ? [{ address: hostname, family }] : await dns.lookup(hostname, { all: true, verbatim: true });
  } catch { throw new StorageError(502, `Source DNS lookup failed (${url.origin}).`); }
  // A mixed public/private answer is forbidden, not an invitation to choose
  // whichever address happens to be public. The chosen answer is pinned below.
  if (!addresses.length || addresses.some(entry => !publicAddress(entry.address) || isIP(entry.address) !== entry.family)) {
    throw new StorageError(403, `Source address is not public (${url.origin}).`);
  }
  return addresses[0];
}

function requestSource(url: URL, address: Address, signal: AbortSignal): Promise<Buffer | URL> {
  return new Promise((resolve, reject) => {
    let response: IncomingMessage | undefined;
    let settled = false;
    const requestOptions: RequestOptions = {
      method: "GET",
      agent: false,
      family: address.family,
      // Keep the original URL hostname for Host, certificate verification and
      // HTTPS SNI. Socket lookup can return only this already-verified address.
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address]);
        else callback(null, address.address, address.family);
      },
      rejectUnauthorized: true,
      headers: { "Accept-Encoding": "identity" },
    };
    const request = (url.protocol === "https:" ? https : http).request(url, requestOptions);
    function finish(error?: Error, result?: Buffer | URL): void {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      response?.destroy();
      request.destroy();
      if (error) reject(error);
      else resolve(result!);
    }
    function abort(): void { finish(signal.reason); }
    signal.addEventListener("abort", abort, { once: true });
    request.once("error", () => finish(new StorageError(502, `Source connection failed (${url.origin}).`)));
    request.once("response", incoming => {
      response = incoming;
      incoming.once("error", () => finish(new StorageError(502, `Source response failed (${url.origin}).`)));
      incoming.once("close", () => {
        if (!incoming.complete) finish(new StorageError(502, `Source response was incomplete (${url.origin}).`));
      });
      const status = incoming.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        if (!incoming.headers.location) return finish(new StorageError(502, `Source HTTP ${status} has no Location (${url.origin}).`));
        try { finish(undefined, sourceUrl(incoming.headers.location, url)); }
        catch (error) { finish(error instanceof Error ? error : new StorageError(502, "Invalid Source redirect.")); }
        return;
      }
      if (status < 200 || status >= 300) return finish(new StorageError(502, `Source returned HTTP ${status} (${url.origin}).`));
      const encoding = incoming.headers["content-encoding"];
      if (encoding && encoding.trim().toLowerCase() !== "identity") {
        return finish(new StorageError(502, `Source returned unsupported Content-Encoding (${url.origin}).`));
      }
      const declared = incoming.headers["content-length"];
      if (declared !== undefined && Number(declared) > MAX_RESOURCE_BYTES) {
        return finish(new StorageError(413, `Source exceeds 16 MiB (${url.origin}).`));
      }
      const chunks: Buffer[] = [];
      let length = 0;
      incoming.on("data", (chunk: Buffer) => {
        if (settled) return;
        length += chunk.length;
        if (length > MAX_RESOURCE_BYTES) return finish(new StorageError(413, `Source exceeds 16 MiB (${url.origin}).`));
        chunks.push(chunk);
      });
      incoming.once("end", () => {
        if (!incoming.complete) return finish(new StorageError(502, `Source response was incomplete (${url.origin}).`));
        finish(undefined, Buffer.concat(chunks, length));
      });
    });
    if (signal.aborted) abort();
    else request.end();
  });
}

/**
 * Download bytes only: public HTTP(S), at most five redirects, 16 MiB and 20s
 * total (including DNS). No decoding, execution, caller headers or proxy agent.
 * StorageError.status: 400 invalid URL; 403 nonpublic destination; 413 size;
 * 499 caller abort; 502 DNS/transport/status/encoding/redirect failure; 504 timeout.
 * Diagnostics include origins/statuses, never URL credentials, queries or bodies.
 */
export async function downloadSource(url: string, options: { signal?: AbortSignal } = {}): Promise<Buffer> {
  let current = sourceUrl(url);
  const controller = new AbortController();
  const abort = () => controller.abort(new StorageError(499, "Source download aborted."));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  const timeout = setTimeout(() => controller.abort(new StorageError(504, "Source download timed out.")), TIMEOUT_MS);
  const signal = controller.signal;
  let rejectAbort: () => void = () => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAbort = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAbort, { once: true });
    if (signal.aborted) rejectAbort();
  });
  const download = async () => {
    const visited = new Set<string>();
    for (let redirects = 0; ; redirects++) {
      signal.throwIfAborted();
      if (redirects > MAX_REDIRECTS || visited.has(current.href)) {
        throw new StorageError(502, `Source redirect limit or loop (${current.origin}).`);
      }
      visited.add(current.href);
      const address = await resolveSource(current);
      signal.throwIfAborted();
      const result = await requestSource(current, address, signal);
      if (Buffer.isBuffer(result)) return result;
      current = result;
    }
  };
  try { return await Promise.race([download(), aborted]); }
  catch (error) {
    if (error instanceof StorageError) throw error;
    throw new StorageError(502, `Source download failed (${current.origin}).`);
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", abort);
    signal.removeEventListener("abort", rejectAbort);
  }
}
