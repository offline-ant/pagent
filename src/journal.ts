import { appendFileSync, closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { AgentEvent, HostEvent } from "./protocol.ts";

/** Transport outbox, not a hidden conversation. A checkpoint retires its delivered records. */
export class EventJournal {
  private filename: string;
  private records: HostEvent[] = [];
  private partials = new Map<string, HostEvent>();
  private sequence = 0;

  constructor(directory: string) {
    this.filename = path.join(directory, "outbox.jsonl");
    if (!existsSync(this.filename)) return;
    const text = readFileSync(this.filename, "utf8");
    const complete = text.slice(0, text.lastIndexOf("\n") + 1);
    for (const line of complete.split("\n")) {
      if (!line) continue;
      const record = JSON.parse(line) as HostEvent;
      if (!Number.isSafeInteger(record.seq) || record.seq <= this.sequence || !record.event?.type) throw new Error("Invalid private event outbox; inspect it before restarting.");
      this.sequence = record.seq;
      this.records.push(record);
    }
    // Only an incomplete final append can be discarded after a process crash.
    if (complete !== text) this.rewrite();
  }

  observeCursor(cursor: number): void {
    if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > Number.MAX_SAFE_INTEGER - 1_000_000) throw new Error("Invalid page event cursor.");
    this.sequence = Math.max(this.sequence, cursor);
  }

  append(event: AgentEvent, scope: Pick<HostEvent, "agentId" | "requestId" | "runId"> = {}): HostEvent {
    const record: HostEvent = { seq: ++this.sequence, ...scope, event: structuredClone(event) };
    const key = JSON.stringify([scope.agentId, scope.runId, scope.requestId, event.type === "tool" ? event.callId : event.type]);
    if ((event.type === "message" || event.type === "tool") && event.phase === "update") {
      // Streaming snapshots replace one another; writing every growing partial is quadratic.
      this.partials.set(key, record);
    } else {
      this.partials.delete(key);
      const fd = openSync(this.filename, "a", 0o600);
      try { appendFileSync(fd, JSON.stringify(record) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
      this.records.push(record);
    }
    return record;
  }

  after(cursor: number): HostEvent[] {
    return [...this.records, ...this.partials.values()].filter(record => record.seq > cursor).sort((a, b) => a.seq - b.seq);
  }

  checkpoint(cursor: number): void {
    this.records = this.records.filter(record => record.seq > cursor);
    for (const [key, value] of this.partials) if (value.seq <= cursor) this.partials.delete(key);
    this.rewrite();
  }

  private rewrite(): void {
    const temporary = `${this.filename}.tmp`;
    const fd = openSync(temporary, "w", 0o600);
    try {
      writeFileSync(fd, this.records.map(record => JSON.stringify(record) + "\n").join(""));
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporary, this.filename);
    const directory = openSync(path.dirname(this.filename), "r");
    try { fsyncSync(directory); } finally { closeSync(directory); }
  }
}
