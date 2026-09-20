import type { BrowserLog } from "./protocol.ts";

export interface DiagnosticEntry extends BrowserLog {
  seq: number;
  time: number;
  truncated: boolean;
}

export interface DiagnosticSnapshot {
  entries: DiagnosticEntry[];
  /** Entries evicted since this host started, not entries consumed by a reader. */
  dropped: number;
  /** Entries shortened since this host started, including entries since evicted. */
  truncated: number;
}

interface DiagnosticLimits {
  maxEntries?: number;
  maxBytes?: number;
  maxEntryBytes?: number;
}

/** A prefix bounded by its JSON-encoded UTF-8 size, without splitting a surrogate pair. */
function boundedString(value: string, bytes: number): string {
  let low = 0;
  let high = Math.min(value.length, bytes);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(JSON.stringify(value.slice(0, middle))) <= bytes) low = middle;
    else high = middle - 1;
  }
  if (low < value.length && low > 0 && /[\uD800-\uDBFF]/.test(value[low - 1])) low--;
  return value.slice(0, low);
}

/**
 * Recent captured tab diagnostics, not a lossless archive or a subscription to all browser workers.
 * Snapshots never consume entries, so independent agents observe the same workspace diagnostics.
 */
export class DiagnosticBuffer {
  private entries: { value: DiagnosticEntry; bytes: number }[] = [];
  private bytes = 0;
  private sequence = 0;
  private dropped = 0;
  private truncated = 0;
  private maxEntries: number;
  private maxBytes: number;
  private maxEntryBytes: number;

  constructor(limits: DiagnosticLimits = {}) {
    this.maxEntries = limits.maxEntries ?? 200;
    this.maxBytes = limits.maxBytes ?? 32 * 1024;
    this.maxEntryBytes = limits.maxEntryBytes ?? Math.min(8 * 1024, this.maxBytes - 256);
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1 ||
        !Number.isSafeInteger(this.maxBytes) || this.maxBytes < 512 ||
        !Number.isSafeInteger(this.maxEntryBytes) || this.maxEntryBytes < 256 || this.maxEntryBytes > this.maxBytes - 256) {
      throw new Error("Diagnostic limits require positive entries, at least 512 total bytes, and 256 <= entry bytes <= total bytes - 256.");
    }
  }

  append(entry: BrowserLog): void {
    if (entry.synthetic) return;
    const value: DiagnosticEntry = {
      seq: ++this.sequence, time: Date.now(), source: entry.source, level: entry.level,
      text: entry.text, truncated: false,
      ...(entry.method === undefined ? {} : { method: entry.method }),
      ...(entry.url === undefined ? {} : { url: entry.url }),
      ...(entry.line === undefined ? {} : { line: entry.line }),
      ...(entry.column === undefined ? {} : { column: entry.column }),
      ...(entry.stack === undefined ? {} : { stack: entry.stack }),
    };
    const fields = ["text", "stack", "url", "level", "method"] as const;
    // Bound each field before serializing the record: page strings may be arbitrarily large.
    for (const key of fields) {
      const text = value[key];
      if (text === undefined) continue;
      const bounded = boundedString(text, this.maxEntryBytes);
      if (bounded !== text) { value[key] = bounded; value.truncated = true; }
    }
    let bytes = Buffer.byteLength(JSON.stringify(value));
    while (bytes > this.maxEntryBytes) {
      const key = fields.reduce((largest, candidate) =>
        Buffer.byteLength(JSON.stringify(value[candidate] ?? "")) > Buffer.byteLength(JSON.stringify(value[largest] ?? "")) ? candidate : largest);
      const text = value[key] ?? "";
      const budget = Math.max(2, Buffer.byteLength(JSON.stringify(text)) - (bytes - this.maxEntryBytes));
      value[key] = boundedString(text, budget);
      value.truncated = true;
      bytes = Buffer.byteLength(JSON.stringify(value));
    }
    if (value.truncated) this.truncated++;
    this.entries.push({ value, bytes });
    this.bytes += bytes + 1;
    // Leave ample space for the snapshot envelope and lifetime counters.
    while (this.entries.length > this.maxEntries || this.bytes > this.maxBytes - 256) {
      this.bytes -= this.entries.shift()!.bytes + 1;
      this.dropped++;
    }
  }

  snapshot(): DiagnosticSnapshot {
    return { entries: this.entries.map(entry => ({ ...entry.value })), dropped: this.dropped, truncated: this.truncated };
  }
}
