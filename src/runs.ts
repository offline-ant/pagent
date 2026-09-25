import type { AgentRun } from "./protocol.ts";

export const MAX_ACTIVE_AGENTS = 8;
export const MAX_AGENTS = 32;
const MAX_COMPLETED_RUNS = 128;

export function validateAgentId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !id || id.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(id)) {
    throw new Error("Agent ID must be nonempty, at most 200 characters, without whitespace or controls.");
  }
}

export function terminal(run: AgentRun): boolean {
  return run.status === "complete" || run.status === "cancelled" || run.status === "error";
}

interface Record {
  run: AgentRun;
  done: Promise<void>;
  resolve: () => void;
}

/** Bounded run receipts and join edges, never a model conversation or browser wait. */
export class Runs {
  private records = new Map<string, Record>();
  private joins = new Map<string, string[]>();

  get(id: string): AgentRun | undefined {
    const record = this.records.get(id);
    return record ? structuredClone(record.run) : undefined;
  }

  start(id: string, agentId: string, inputId: string): AgentRun {
    validateAgentId(id);
    if (this.records.has(id)) throw new Error(`Run ID already exists: ${id}`);
    if ([...this.records.values()].filter(record => !terminal(record.run)).length >= MAX_ACTIVE_AGENTS) {
      throw new Error(`At most ${MAX_ACTIVE_AGENTS} agents may run concurrently. Cancel or wait before prompting another.`);
    }
    let resolve = () => {};
    const done = new Promise<void>(settle => { resolve = settle; });
    const run: AgentRun = { id, agentId, inputId, status: "running", result: "" };
    this.records.set(id, { run, done, resolve });
    return structuredClone(run);
  }

  finish(run: AgentRun): void {
    const record = this.records.get(run.id);
    if (!record || terminal(record.run)) return;
    if (!terminal(run)) throw new Error("A finished run must have a terminal status.");
    record.run = structuredClone(run);
    record.resolve();
    this.joins.delete(run.id);
    this.retain(record);
  }

  reject(run: AgentRun): void {
    if (this.records.has(run.id)) return;
    if (run.status !== "error" && run.status !== "cancelled") throw new Error("A rejected run must have error or cancelled status.");
    this.retain({ run: structuredClone(run), done: Promise.resolve(), resolve: () => {} });
  }

  private retain(record: Record): void {
    // Completion order, not start order: a long-running early task remains recent.
    this.records.delete(record.run.id);
    this.records.set(record.run.id, record);
    const completed = [...this.records].filter(([, value]) => terminal(value.run));
    for (const [id] of completed.slice(0, Math.max(0, completed.length - MAX_COMPLETED_RUNS))) this.records.delete(id);
  }

  async wait(caller: string, ids: string[], signal?: AbortSignal): Promise<AgentRun[]> {
    signal?.throwIfAborted();
    if (!ids.length || ids.length > MAX_ACTIVE_AGENTS || new Set(ids).size !== ids.length) throw new Error("Wait needs 1–8 unique run IDs.");
    const records = ids.map(id => {
      const record = this.records.get(id);
      if (!record) throw new Error(`Unknown or expired run ID: ${id}. Run receipts are retained for this host's 128 most recent completions; inspect saved element records for older results.`);
      return record;
    });
    const reaches = (id: string, seen = new Set<string>()): boolean => {
      if (id === caller) return true;
      if (seen.has(id)) return false;
      seen.add(id);
      return (this.joins.get(id) ?? []).some(next => reaches(next, seen));
    };
    if (ids.some(id => reaches(id))) throw new Error("Agent join would create a wait cycle (including waiting for yourself).");
    this.joins.set(caller, ids);
    let abort = () => {};
    try {
      await Promise.race([
        Promise.all(records.map(record => record.done)),
        new Promise<never>((_resolve, reject) => {
          abort = () => reject(signal?.reason ?? new Error("Agent wait cancelled."));
          signal?.addEventListener("abort", abort, { once: true });
        }),
      ]);
      signal?.throwIfAborted();
      return records.map(record => structuredClone(record.run));
    } finally {
      signal?.removeEventListener("abort", abort);
      this.joins.delete(caller);
    }
  }
}
