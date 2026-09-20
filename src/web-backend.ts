import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isWebBackend, type WebBackend } from "pi-browser/web";
import { atomicWrite } from "./storage.ts";

/** Workspace preferences are private host state, independent of HTML and its history. */
export async function readWebBackendOverride(stateDirectory: string): Promise<WebBackend | null> {
  let text: string;
  try { text = await readFile(join(stateDirectory, "web-backend.json"), "utf8"); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  const value: unknown = JSON.parse(text);
  if (value !== null && !isWebBackend(value)) throw new Error("Invalid private web backend override in web-backend.json.");
  return value;
}

export function writeWebBackendOverride(stateDirectory: string, override: WebBackend | null): Promise<void> {
  if (override !== null && !isWebBackend(override)) throw new Error("Invalid web backend override.");
  return atomicWrite(join(stateDirectory, "web-backend.json"), Buffer.from(`${JSON.stringify(override)}\n`));
}
