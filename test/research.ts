import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { BrowserClient } from "pi-browser/web";
import type { BrowserKind } from "../src/protocol.ts";

/** pi-browser brokers live under os.tmpdir(); point it at a disposable directory for the test. Returns the restore function. */
export function isolateBrokers(directory: string): () => void {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = directory;
  return () => { if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous; };
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Call before closing the workspace: brokers remove their records while stopping. Research brokers have no idle
 * grace, so the returned wait resolves once they (and their browsers) exited after their engines closed.
 */
export async function brokerExit(directory: string): Promise<() => Promise<void>> {
  const brokers = join(directory, `pi-browser-${process.getuid!()}`);
  const pids: number[] = [];
  for (const name of await readdir(brokers).catch(() => [])) {
    if (name.endsWith(".json")) pids.push(JSON.parse(await readFile(join(brokers, name), "utf8")).pid);
  }
  return async () => {
    const deadline = Date.now() + 15_000;
    while (pids.some(alive)) {
      if (Date.now() > deadline) throw new Error(`Research brokers still running: ${pids.join(", ")}`);
      await delay(50);
    }
  };
}

export function researchProfile(stateDirectory: string, agentId: string, engine: BrowserKind): string {
  return join(stateDirectory, "research", createHash("sha256").update(agentId).digest("hex"), engine);
}

/** A second client of an agent's research broker, acting as the person at the research window. */
export class ResearchObserver {
  private client: BrowserClient;

  constructor(stateDirectory: string, agentId: string, engine: BrowserKind) {
    this.client = new BrowserClient({ source: { browser: engine, profileDir: researchProfile(stateDirectory, agentId, engine), headless: true },
      session: "test-observer", idleMs: 0 });
  }

  async evaluate(tab: string, expression: string): Promise<unknown> {
    const shared = (await this.client.open({ tab })).tab;
    try { return await shared.evaluate(expression); }
    finally { await shared.release(); }
  }

  /** Interrupting a never-settling evaluation closes exactly that tab. */
  async closeTab(tab: string): Promise<void> {
    const shared = (await this.client.open({ tab })).tab;
    const controller = new AbortController();
    const running = shared.evaluate("new Promise(() => {})", { signal: controller.signal, timeoutMs: 20_000 });
    setTimeout(() => controller.abort(), 100);
    await running.then(() => { throw new Error("Endless evaluation settled"); }, () => {});
    await shared.release();
  }

  close(): Promise<void> { return this.client.close(); }
}
