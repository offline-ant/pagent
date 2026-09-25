import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { validateEntryDocument } from "./entry-document.ts";

export const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;

export class StorageError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StorageError";
    this.status = status;
  }
}

export interface ResourceEntry {
  name: string;
  type: "file" | "directory";
  size?: number;
}

export interface Workspace {
  readonly directory: string;
  readonly stateDirectory: string;
  read(resource: string): Promise<Buffer>;
  write(resource: string, bytes: Buffer, options?: { signal?: AbortSignal }): Promise<void>;
  list(resource: string): Promise<ResourceEntry[]>;
  remove(resource: string, options?: { signal?: AbortSignal }): Promise<void>;
  checkpoint(html: string): Promise<string>;
  /** Store a revision without modifying the public starting document. */
  checkpointPrivate(html: string): Promise<string>;
  close(): Promise<void>;
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
}

/** Validate before URL normalization, including encoded and double-encoded traversal. */
export function resourcePath(resource: string, directory = false): string {
  if (typeof resource !== "string" || resource.length > 4096 || /[?#\\\u0000-\u001f\u007f]/u.test(resource) || /%(?:2f|5c|00)/i.test(resource)) {
    throw new StorageError(400, "Invalid resource path.");
  }
  let decoded: string;
  try { decoded = decodeURIComponent(resource); } catch { throw new StorageError(400, "Invalid resource encoding."); }
  if (/[?#\\%\u0000-\u001f\u007f]/u.test(decoded)) throw new StorageError(400, "Invalid resource path.");
  if (decoded === "/" || decoded === "") return directory ? "" : "index.html";
  if (directory && decoded.endsWith("/")) decoded = decoded.slice(0, -1);
  const relative = decoded.startsWith("/") ? decoded.slice(1) : decoded;
  if (relative.split("/").some(segment => !segment || segment.startsWith(".") || segment.includes(":"))) {
    throw new StorageError(403, "Resource path is not allowed.");
  }
  return relative;
}

/** Existing ancestors must be real directories, never symlinks. */
async function directoryAt(directory: string, create: boolean): Promise<void> {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const segment of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    if (create) {
      try { await mkdir(current); } catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    }
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new StorageError(403, "Symlink or non-directory ancestor is not allowed.");
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function checkDestination(destination: string): Promise<void> {
  try {
    const info = await lstat(destination);
    if (info.isSymbolicLink() || !info.isFile()) throw new StorageError(403, "Resource must be a regular file.");
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
}

export async function atomicWrite(destination: string, bytes: Buffer, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const directory = path.dirname(destination);
  await directoryAt(directory, true);
  await checkDestination(destination);
  const temporary = path.join(directory, `.pagent-write-${randomUUID()}`);
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally { await handle.close(); }
  try {
    signal?.throwIfAborted();
    await rename(temporary, destination);
    await syncDirectory(directory);
  } finally { await rm(temporary, { force: true }); }
}

interface LockRecord { pid: number; token: string }

function lockRecord(text: string): LockRecord | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null || !("pid" in value) || !("token" in value)) return undefined;
    if (!Number.isSafeInteger(value.pid) || typeof value.pid !== "number" || value.pid <= 0 || typeof value.token !== "string") return undefined;
    return { pid: value.pid, token: value.token };
  } catch { return undefined; }
}

async function acquireLock(stateDirectory: string): Promise<() => Promise<void>> {
  const filename = path.join(stateDirectory, "host.lock");
  const token = randomUUID();
  let handle;
  try {
    handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    await checkDestination(filename);
    const owner = lockRecord(await readFile(filename, "utf8"));
    if (!owner) throw new Error(`Workspace lock is incomplete: ${filename}. Remove it manually only after confirming no workspace process is running.`);
    try {
      process.kill(owner.pid, 0);
    } catch (probe) {
      if (errorCode(probe) === "ESRCH") {
        throw new Error(`Stale workspace lock for process ${owner.pid}: ${filename}. Remove it manually only after confirming the owner is no longer running.`);
      }
      if (errorCode(probe) !== "EPERM") throw probe;
    }
    throw new Error(`Workspace is already open by process ${owner.pid}: ${filename}.`);
  }
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    await handle.sync();
  } catch (error) {
    await unlink(filename);
    throw error;
  } finally { await handle.close(); }
  return async () => {
    const owner = lockRecord(await readFile(filename, "utf8"));
    if (owner?.token !== token) throw new Error("Workspace lock ownership changed.");
    await unlink(filename);
    await syncDirectory(stateDirectory);
  };
}

async function readResource(filename: string): Promise<Buffer> {
  await directoryAt(path.dirname(filename), false);
  await checkDestination(filename);
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new StorageError(403, "Resource must be a regular file.");
    if (info.size > MAX_RESOURCE_BYTES) throw new StorageError(413, "Resource exceeds 16 MiB.");
    const bytes = await handle.readFile();
    if (bytes.length > MAX_RESOURCE_BYTES) throw new StorageError(413, "Resource exceeds 16 MiB.");
    return bytes;
  } finally { await handle.close(); }
}

interface WorkspaceOptions {
  directory: string;
  templateDir: string;
}

/** Validate the entry point before creating private state or touching existing files. */
export async function openWorkspace(options: WorkspaceOptions): Promise<Workspace> {
  const directory = path.resolve(options.directory);
  const stateDirectory = path.join(directory, ".pagent");
  let seeds: Map<string, Buffer> | undefined;
  try {
    validateEntryDocument((await readResource(path.join(directory, "index.html"))).toString());
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    seeds = new Map();
    for (const entry of await readdir(options.templateDir, { withFileTypes: true })) {
      resourcePath(entry.name);
      if (!entry.isFile()) throw new StorageError(403, "Starter resources must be regular files, not directories or symlinks.");
      seeds.set(entry.name, await readResource(path.join(options.templateDir, entry.name)));
      try { await lstat(path.join(directory, entry.name)); }
      catch (collision) { if (errorCode(collision) === "ENOENT") continue; throw collision; }
      throw new Error(`Cannot create starter: ${path.join(directory, entry.name)} already exists. Move it or provide your own index.html; no files were overwritten.`);
    }
    const html = seeds.get("index.html");
    if (!html) throw new Error("Starter template has no index.html.");
    validateEntryDocument(html.toString());
  }
  await directoryAt(directory, true);
  try { await mkdir(stateDirectory, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
  await directoryAt(stateDirectory, false);
  const release = await acquireLock(stateDirectory);
  try {
    if (seeds) {
      // Publish index.html last; exclusive creation never replaces a concurrent edit.
      const created: string[] = [];
      try {
        for (const [name, bytes] of [...seeds].sort(([a], [b]) => Number(a === "index.html") - Number(b === "index.html"))) {
          const filename = path.join(directory, name);
          const handle = await open(filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          created.push(filename);
          try { await handle.writeFile(bytes); await handle.sync(); }
          finally { await handle.close(); }
        }
        await syncDirectory(directory);
      } catch (error) {
        await Promise.all(created.map(filename => unlink(filename)));
        throw error;
      }
    }
  } catch (error) {
    await release();
    throw error;
  }
  let closing = false;
  let closed: Promise<void> | undefined;
  let writes: Promise<unknown> = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (closing) return Promise.reject(new Error("Workspace is closed."));
    const result = writes.then(operation);
    writes = result.catch(() => {});
    return result;
  }

  function checkpoint(html: string, publish: boolean): Promise<string> {
    const bytes = Buffer.from(html);
    if (bytes.length > MAX_RESOURCE_BYTES) return Promise.reject(new StorageError(413, "Document exceeds 16 MiB."));
    return enqueue(async () => {
      const revision = `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}.html`;
      await atomicWrite(path.join(stateDirectory, "revisions", revision), bytes);
      // A crash may leave an extra revision, but never a half-written root document.
      if (publish) await atomicWrite(path.join(directory, "index.html"), bytes);
      return revision;
    });
  }

  return {
    directory, stateDirectory,
    async read(resource) {
      if (closing) throw new Error("Workspace is closed.");
      return readResource(path.join(directory, resourcePath(resource)));
    },
    async write(resource, bytes, options) {
      const relative = resourcePath(resource);
      if (bytes.length > MAX_RESOURCE_BYTES) return Promise.reject(new StorageError(413, "Resource exceeds 16 MiB."));
      const data = Buffer.from(bytes);
      return enqueue(() => atomicWrite(path.join(directory, relative), data, options?.signal));
    },
    async list(resource) {
      const relative = resourcePath(resource, true);
      return enqueue(async () => {
        const destination = path.join(directory, relative);
        await directoryAt(destination, false);
        const entries: ResourceEntry[] = [];
        for (const name of await readdir(destination)) {
          try { resourcePath(name); } catch (error) {
            if (error instanceof StorageError) continue;
            throw error;
          }
          const info = await lstat(path.join(destination, name));
          if (info.isFile()) entries.push({ name, type: "file", size: info.size });
          else if (info.isDirectory()) entries.push({ name, type: "directory" });
        }
        return entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      });
    },
    async remove(resource, options) {
      if (resource === "" || resource === "/") throw new StorageError(403, "Cannot delete the resource root.");
      const relative = resourcePath(resource);
      return enqueue(async () => {
        options?.signal?.throwIfAborted();
        const destination = path.join(directory, relative);
        await directoryAt(path.dirname(destination), false);
        await checkDestination(destination);
        options?.signal?.throwIfAborted();
        await unlink(destination);
        await syncDirectory(path.dirname(destination));
      });
    },
    checkpoint: html => checkpoint(html, true),
    checkpointPrivate: html => checkpoint(html, false),
    close() {
      closing = true;
      closed ??= writes.then(release);
      return closed;
    },
  };
}
