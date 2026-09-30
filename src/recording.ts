import { randomUUID } from "node:crypto";
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { HostEvent, PageBrowser } from "./protocol.ts";

export type RecordingEventKind = "tool" | "thinking" | "message";

interface Completion {
  kind: RecordingEventKind;
  seq: number;
  agentId?: string;
  requestId?: string;
  runId?: string;
  callId?: string;
  contentIndex?: number;
  deliveredMs: number;
}

interface Completions {
  events: Completion[];
  omittedEvents: number;
}

/** A monotonic clock; scheduling returns a cancellation function. */
export interface RecordingClock {
  now(): number;
  wallTime(): string;
  schedule(callback: () => void, delayMs: number): () => void;
}

const clock: RecordingClock = {
  now: () => performance.now(),
  wallTime: () => new Date().toISOString(),
  schedule(callback, delayMs) {
    const timer = setTimeout(callback, delayMs);
    return () => clearTimeout(timer);
  },
};

const CAPTURE_BUDGET_MS = 2_000;
// Shared-page bursts coalesce; a busy renderer never drives a capture loop.
const EVENT_QUIET_MS = 1_000;
const MAX_COMPLETIONS = 32;

interface RecorderOptions {
  stateDirectory: string;
  /** Previous completed interval archive in this workspace, never replayed. */
  previous?: string;
  browser: Pick<PageBrowser, "captureFrame">;
  intervalMs: number;
  screenshots?: boolean;
  events?: RecordingEventKind[];
  log?: (message: string) => void;
  clock?: RecordingClock;
}

/** Independent evidence, never a workspace save or a page-visible event. */
export class DomRecorder {
  readonly directory: string;
  private readonly options: RecorderOptions;
  private readonly clock: RecordingClock;
  private state: "new" | "running" | "stopping" | "stopped" = "new";
  private origin = 0;
  private cancelTick?: () => void;
  private inflight?: Promise<void>;
  private writes: Promise<void> = Promise.resolve();
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private frameNumber = 0;
  private readonly events: ReadonlySet<RecordingEventKind>;
  private eventsDisabled = false;
  private pending?: Completions;
  private cancelEvent?: () => void;

  constructor(options: RecorderOptions) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs < 1 || options.intervalMs > 2_147_483_647) {
      throw new Error("Recording intervalMs must be a positive integer no greater than 2147483647.");
    }
    this.options = options;
    this.events = new Set(options.events ?? []);
    this.clock = options.clock ?? clock;
    this.directory = path.join(options.stateDirectory, "recordings", `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID()}`);
  }

  start(): Promise<void> {
    if (this.starting) return this.starting;
    if (this.state !== "new") return Promise.reject(new Error("A stopped recording cannot be restarted."));
    this.starting = this.begin();
    return this.starting;
  }

  stop(): Promise<void> {
    this.stopping ??= this.finish();
    return this.stopping;
  }

  /** Called only after live page delivery acknowledges this record; never await capture. */
  observe(record: HostEvent): void {
    if (this.state !== "running" || this.eventsDisabled || !this.events.size) return;
    const event = record.event;
    let kind: RecordingEventKind;
    if (event.type === "tool" && event.phase === "end") kind = "tool";
    else if (event.type === "message" && event.phase === "update" && event.thinkingEnd !== undefined) kind = "thinking";
    else if (event.type === "message" && event.phase === "end" && event.message && typeof event.message === "object"
      && "role" in event.message && event.message.role === "assistant") kind = "message";
    else return;
    if (!this.events.has(kind)) return;
    this.pending ??= { events: [], omittedEvents: 0 };
    if (this.pending.events.length < MAX_COMPLETIONS) {
      const completion: Completion = { kind, seq: record.seq, deliveredMs: this.clock.now() - this.origin };
      for (const key of ["agentId", "requestId", "runId"] as const) {
        if (record[key] !== undefined) completion[key] = record[key].slice(0, 200);
      }
      if (event.type === "tool") completion.callId = event.callId.slice(0, 200);
      if (event.type === "message" && event.thinkingEnd !== undefined) completion.contentIndex = event.thinkingEnd;
      this.pending.events.push(completion);
    } else this.pending.omittedEvents++;
    this.scheduleEvent();
  }

  /** Runtime invalidation is terminal for completion sampling in this recording. */
  disableEvents(): void {
    this.eventsDisabled = true;
    this.cancelEvent?.();
    this.cancelEvent = undefined;
    if (this.pending) {
      this.note({ type: "skip", reason: "completion triggers disabled", count: this.pending.events.length + this.pending.omittedEvents, ...this.pending });
      this.pending = undefined;
    }
  }

  private scheduleEvent(): void {
    if (this.state !== "running" || this.eventsDisabled || this.inflight || this.cancelEvent || !this.pending) return;
    this.cancelEvent = this.clock.schedule(() => {
      this.cancelEvent = undefined;
      if (this.state !== "running" || this.eventsDisabled || this.inflight || !this.pending) return;
      void this.capture(this.clock.now() - this.origin, "event");
    }, EVENT_QUIET_MS);
  }

  private async begin(): Promise<void> {
    if (!this.options.browser.captureFrame) throw new Error("This browser does not support private DOM recording.");
    await mkdir(path.join(this.directory, "frames"), { recursive: true, mode: 0o700 });
    await writeFile(path.join(this.directory, "viewer.html"), RECORDING_VIEWER, { mode: 0o600 });
    this.origin = this.clock.now();
    if (this.state !== "stopping") this.state = "running";
    await this.record({ type: "start", version: 1, intervalMs: this.options.intervalMs, screenshots: this.options.screenshots ?? false, events: [...this.events], ...(this.options.previous ? { previous: this.options.previous } : {}) });
    const baseline = this.capture(0, "baseline");
    this.schedule(1);
    if (!await this.within(baseline, CAPTURE_BUDGET_MS)) {
      await this.record({ type: "error", phase: "baseline", message: "Baseline capture exceeded its time budget; recording continues without overlapping captures." });
    }
  }

  private schedule(tick: number): void {
    if (this.state !== "running") return;
    const intendedMs = tick * this.options.intervalMs;
    this.cancelTick = this.clock.schedule(() => {
      this.cancelTick = undefined;
      if (this.state !== "running") return;
      const elapsed = this.clock.now() - this.origin;
      const current = Math.max(tick, Math.floor(elapsed / this.options.intervalMs));
      if (current > tick) this.note({ type: "skip", reason: "timer delayed", firstTick: tick, count: current - tick, intendedMs });
      const planned = current * this.options.intervalMs;
      if (this.inflight) this.note({ type: "skip", reason: "capture in flight", firstTick: current, count: 1, intendedMs: planned });
      else void this.capture(planned, "sample");
      this.schedule(current + 1);
    }, Math.max(0, this.origin + intendedMs - this.clock.now()));
  }

  private capture(intendedMs: number, phase: "baseline" | "sample" | "event" | "final"): Promise<void> {
    this.cancelEvent?.();
    this.cancelEvent = undefined;
    const completions = this.pending;
    this.pending = undefined;
    const number = this.frameNumber++;
    const startedMs = this.clock.now() - this.origin;
    const startedAt = this.clock.wallTime();
    const task = (async () => {
      const frame = await this.options.browser.captureFrame!({ screenshot: this.options.screenshots ?? false });
      // A capture that outlives stop must not resurrect the archive or write a late frame.
      if (this.isStopped()) return;
      const capturedMs = this.clock.now() - this.origin;
      const name = String(number).padStart(8, "0");
      const html = `frames/${name}.html`;
      await writeFile(path.join(this.directory, html), frame.html, { mode: 0o600 });
      let screenshot: string | undefined;
      if (this.options.screenshots && frame.screenshot !== undefined) {
        screenshot = `frames/${name}.png`;
        await writeFile(path.join(this.directory, screenshot), Buffer.from(frame.screenshot, "base64"), { mode: 0o600 });
      }
      if (this.isStopped()) return;
      await this.record({ type: "frame", number, phase, intendedMs, startedMs, startedAt, capturedMs, html,
        ...(screenshot ? { screenshot } : {}), ...completions });
    })().catch(async error => {
      if (this.state === "stopped") return;
      await this.record({ type: "error", phase, intendedMs, startedMs, message: String(error), ...completions }).catch(failure => this.log(failure));
      this.log(error);
    }).finally(() => {
      if (this.inflight === task) this.inflight = undefined;
      this.scheduleEvent();
    });
    this.inflight = task;
    return task;
  }

  private async finish(): Promise<void> {
    if (this.state === "new" && !this.starting) { this.state = "stopped"; return; }
    this.state = "stopping";
    this.disableEvents();
    this.cancelTick?.();
    this.cancelTick = undefined;
    try { await this.starting; } catch { this.state = "stopped"; return; }
    const deadline = this.clock.now() + CAPTURE_BUDGET_MS;
    const pending = this.inflight;
    if (pending && !await this.within(pending, Math.max(0, deadline - this.clock.now()))) {
      this.note({ type: "error", phase: "stop", message: "Capture did not settle before stop; final frame omitted." });
    } else if (this.clock.now() < deadline) {
      const final = this.capture(this.clock.now() - this.origin, "final");
      if (!await this.within(final, Math.max(0, deadline - this.clock.now()))) {
        this.note({ type: "error", phase: "stop", message: "Final capture exceeded the stop time budget." });
      }
    }
    this.state = "stopped";
    this.note({ type: "stop" });
    // Bound archive flushing independently of the renderer. Pending operations
    // already have rejection handlers and may finish after this method returns.
    if (!await this.within(this.writes, CAPTURE_BUDGET_MS)) this.log("Recording manifest flush exceeded its time budget.");
  }

  private record(value: Record<string, unknown>): Promise<void> {
    const line = JSON.stringify({ ...value, actualMs: this.clock.now() - this.origin, at: this.clock.wallTime() }) + "\n";
    const result = this.writes.then(() => appendFile(path.join(this.directory, "manifest.jsonl"), line, { mode: 0o600 }));
    this.writes = result.catch(error => this.log(error));
    return result;
  }

  private note(value: Record<string, unknown>): void {
    void this.record(value).catch(() => {}); // record's queue already reports filesystem failures.
  }

  private isStopped(): boolean { return this.state === "stopped"; }

  private log(error: unknown): void { this.options.log?.(`Recording: ${String(error)}`); }

  private within(operation: Promise<void>, durationMs: number): Promise<boolean> {
    return new Promise(resolve => {
      const cancel = this.clock.schedule(() => resolve(false), durationMs);
      void operation.then(() => { cancel(); resolve(true); }, () => { cancel(); resolve(false); });
    });
  }
}

/** File-picker playback deliberately never loads or executes recorded HTML. */
export const RECORDING_VIEWER = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src blob:; connect-src 'none'; base-uri 'none'; form-action 'none'">
<title>Pagent recording</title>
<style>
body{margin:0;background:#171717;color:#eee;font:14px system-ui}header{padding:1rem;display:flex;gap:1rem;align-items:center;flex-wrap:wrap}input[type=range]{flex:1;min-width:15rem}img{display:block;max-width:100vw;max-height:calc(100vh - 9rem);margin:auto}pre{white-space:pre-wrap;padding:1rem}button{font:inherit}#details{padding:0 1rem}
</style>
<header><label>Open recording folder <input id="files" type="file" webkitdirectory multiple></label><button id="play" disabled>Play</button><input id="position" type="range" min="0" max="0" value="0" disabled><output id="time"></output></header>
<p id="details">Select the folder containing manifest.jsonl and frames/. This viewer only displays PNGs; archived HTML is never executed.</p>
<img id="image" alt="Recorded viewport" hidden><pre id="empty"></pre>
<script>
const files=document.querySelector('#files'),slider=document.querySelector('#position'),image=document.querySelector('#image'),play=document.querySelector('#play'),time=document.querySelector('#time'),details=document.querySelector('#details'),empty=document.querySelector('#empty');
let frames=[],assets=new Map(),url,timer;
function pause(){clearTimeout(timer);timer=undefined;play.textContent='Play'}
function show(){if(url)URL.revokeObjectURL(url);url=undefined;const frame=frames[Number(slider.value)];if(!frame)return;time.textContent=(frame.capturedMs/1000).toFixed(2)+' s · '+(Number(slider.value)+1)+' / '+frames.length;const file=assets.get(frame.screenshot);image.hidden=!file;empty.textContent=file?'':'No screenshot for this frame. DOM evidence: '+frame.html;if(file){url=URL.createObjectURL(file);image.src=url}else image.removeAttribute('src')}
function advance(){const next=Number(slider.value)+1;if(next>=frames.length){pause();return}const wait=Math.max(0,frames[next].capturedMs-frames[next-1].capturedMs);timer=setTimeout(()=>{slider.value=String(next);show();advance()},wait)}
files.addEventListener('change',async()=>{pause();frames=[];assets=new Map();try{const selected=[...files.files],manifest=selected.find(file=>file.name==='manifest.jsonl');if(!manifest)throw Error('Select a recording folder containing manifest.jsonl.');const prefix=manifest.webkitRelativePath.slice(0,-manifest.name.length);for(const file of selected)assets.set(file.webkitRelativePath.slice(prefix.length),file);const records=(await manifest.text()).split('\\n').filter(Boolean).map(line=>JSON.parse(line));frames=records.filter(record=>record.type==='frame').sort((a,b)=>a.capturedMs-b.capturedMs);slider.max=String(Math.max(0,frames.length-1));slider.value='0';slider.disabled=play.disabled=!frames.length;details.textContent=frames.length+' frames · '+records.filter(record=>record.type==='skip').reduce((sum,record)=>sum+record.count,0)+' skipped samples/completions · '+records.filter(record=>record.type==='error').length+' errors. DOM and screenshot observations are not atomic.';show()}catch(error){details.textContent=String(error);slider.disabled=play.disabled=true;image.hidden=true}});
slider.addEventListener('input',()=>{pause();show()});play.addEventListener('click',()=>{if(timer!==undefined){pause();return}if(Number(slider.value)>=frames.length-1){slider.value='0';show()}play.textContent='Pause';advance()});
</script>
`;
