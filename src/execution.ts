import type { AgentConfiguration, ExecutionState } from "./agent-config.ts";
import type { AgentRun } from "./protocol.ts";

interface Participant { id: string; configuration: AgentConfiguration }
interface Member { continuous: boolean; delay: number; timer?: ReturnType<typeof setTimeout>; pending: boolean; generation: number; scheduleId?: string }
interface ExecutionOptions {
  durationMs?: number;
  deadlinePolicy?: "close" | "pause";
  repeatDelayMs?: number;
  participants: () => Participant[];
  prompt: (id: string, scheduleId: string, current: () => boolean) => Promise<void>;
  flush: () => Promise<void>;
  cancel: () => Promise<void>;
  changed: (state: ExecutionState) => void;
  onStart?: () => Promise<void>;
  onPause?: () => Promise<void>;
  onStop?: () => Promise<void>;
  log: (message: string) => void;
}

/** Host-clock repetition; the page owns conversation, never admission or timers. */
export class Execution {
  private options: ExecutionOptions;
  private members = new Map<string, Member>();
  private deadline?: ReturnType<typeof setTimeout>;
  private starting?: Promise<void>;
  private stopping?: Promise<void>;
  private current: ExecutionState = "armed";

  constructor(options: ExecutionOptions) {
    for (const [name, value] of [["durationMs", options.durationMs], ["repeatDelayMs", options.repeatDelayMs]] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < (name === "durationMs" ? 1 : 0) || value > 2_147_483_647)) throw new Error(`${name} must be integer milliseconds ${name === "durationMs" ? "1" : "0"} through 2147483647.`);
    }
    if (options.deadlinePolicy !== undefined && options.deadlinePolicy !== "close" && options.deadlinePolicy !== "pause") throw new Error("deadlinePolicy must be close or pause.");
    if (options.deadlinePolicy === "pause" && options.durationMs === undefined) throw new Error("deadlinePolicy pause requires durationMs.");
    this.options = options;
  }

  get state(): ExecutionState { return this.current; }
  get blocked(): boolean { return this.current !== "running" && (this.current !== "armed" || this.options.durationMs !== undefined); }

  async start(): Promise<void> {
    if (this.current === "stopped") throw new Error("Execution has stopped; restart the host for another run.");
    if (this.current === "paused" || this.current === "pausing") throw new Error("Execution is paused; only the host operator can continue it.");
    if (this.starting) { await this.starting; return; }
    if (this.current === "running") { await this.nudge(); return; }
    for (const { id, configuration } of this.options.participants()) {
      if (!configuration.repeatPromptSource) continue;
      this.members.set(id, { continuous: configuration.mode === "continuous",
        delay: configuration.repeatDelayMs ?? this.options.repeatDelayMs ?? 1000, pending: false, generation: 0 });
    }
    await this.beginInterval();
  }

  /** Host-only. Never exposed through the page request protocol. */
  async continue(): Promise<void> {
    if (this.current !== "paused") throw new Error("Execution must finish pausing before the operator can continue it.");
    // New dispatch objects isolate old asynchronous prompt/flush completions.
    for (const [id, member] of this.members) this.members.set(id, {
      continuous: member.continuous, delay: member.delay,
      pending: false, generation: member.generation + 1,
    });
    await this.beginInterval();
  }

  private async beginInterval(): Promise<void> {
    this.current = "running";
    if (this.options.durationMs !== undefined) this.deadline = setTimeout(() => {
      const ending = this.options.deadlinePolicy === "pause" ? this.pauseAtDeadline() : this.stop();
      void ending.catch(error => this.options.log(`Execution deadline failed: ${String(error)}`));
    }, this.options.durationMs);
    // Install the operation before notifying host observers, which may stop or
    // close synchronously. A paused interval always joins this startup.
    const starting = Promise.resolve().then(async () => {
      if (this.current !== "running") return;
      await this.options.onStart?.();
      if (this.current === "running") await this.nudge();
    });
    this.starting = starting;
    this.options.changed(this.current);
    try { await starting; }
    catch (error) { await this.stop(); throw error; }
    finally { if (this.starting === starting) this.starting = undefined; }
  }

  private async pauseAtDeadline(): Promise<void> {
    if (this.current !== "running") return;
    this.current = "pausing";
    clearTimeout(this.deadline);
    for (const id of this.members.keys()) this.pause(id);
    this.options.changed(this.current);
    if (this.current !== "pausing") return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const settle = async () => {
        await Promise.all([this.starting, this.options.cancel(), this.options.onPause?.()]);
        await this.options.flush();
      };
      await Promise.race([settle(), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Deadline pause did not settle within six seconds; closing instead of allowing unsafe continuation.")), 6_000);
      })]);
      if (this.current !== "pausing") return; // Explicit stop/close always wins.
      this.current = "paused";
      this.options.changed(this.current);
    } catch (error) {
      await this.stop();
      throw error;
    } finally { clearTimeout(timer); }
  }

  async nudge(): Promise<void> {
    if (this.current !== "running") throw new Error("Start execution before nudging agents.");
    await Promise.all([...this.members].map(([id, member]) => this.prompt(id, member)));
  }

  private async prompt(id: string, member: Member): Promise<void> {
    clearTimeout(member.timer);
    member.timer = undefined;
    if (this.current !== "running" || this.members.get(id) !== member || member.pending) return;
    member.pending = true;
    const generation = member.generation;
    const scheduleId = crypto.randomUUID();
    member.scheduleId = scheduleId;
    const current = () => this.current === "running" && this.members.get(id) === member && member.generation === generation;
    try { await this.options.prompt(id, scheduleId, current); }
    catch (error) { this.options.log(`Agent ${id} could not be prompted: ${String(error)}`); }
    finally { member.pending = false; }
  }

  completed(run: AgentRun): void {
    const member = this.members.get(run.agentId);
    if (!member || !member.continuous || run.status !== "complete" || this.current !== "running") return;
    const generation = member.generation;
    void this.options.flush().then(() => {
      if (this.current !== "running" || this.members.get(run.agentId) !== member || member.generation !== generation) return;
      clearTimeout(member.timer);
      member.timer = setTimeout(() => { void this.prompt(run.agentId, member); }, member.delay);
    }).catch(error => this.options.log(`Agent ${run.agentId} repetition paused: ${String(error)}`));
  }

  pause(id: string): void {
    const member = this.members.get(id);
    if (member) { clearTimeout(member.timer); member.timer = undefined; member.scheduleId = undefined; member.generation++; }
  }

  /** A queued browser expression may arrive after cancellation; only the current dispatch is admitted. */
  accept(id: string, scheduleId: string): boolean {
    const member = this.members.get(id);
    if (this.current !== "running" || !member || member.scheduleId !== scheduleId) return false;
    member.scheduleId = undefined;
    return true;
  }

  remove(id: string): void { this.pause(id); this.members.delete(id); }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    this.current = "stopped";
    clearTimeout(this.deadline);
    for (const id of this.members.keys()) this.pause(id);
    this.members.clear();
    const stopped = Promise.withResolvers<void>();
    this.stopping = stopped.promise;
    this.options.changed(this.current);
    void (async () => {
      try { await this.options.onStop?.(); }
      finally { await this.options.cancel(); }
    })().then(stopped.resolve, stopped.reject);
    return this.stopping;
  }
}
