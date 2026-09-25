import type { AgentConfiguration, ExecutionState } from "./agent-config.ts";
import type { AgentRun } from "./protocol.ts";

interface Participant { id: string; configuration: AgentConfiguration }
interface Member { prompt: string; continuous: boolean; delay: number; timer?: ReturnType<typeof setTimeout>; pending: boolean; generation: number; scheduleId?: string }
interface ExecutionOptions {
  durationMs?: number;
  repeatDelayMs?: number;
  participants: () => Participant[];
  prompt: (id: string, text: string, scheduleId: string, current: () => boolean) => Promise<void>;
  flush: () => Promise<void>;
  cancel: () => Promise<void>;
  changed: (state: ExecutionState) => void;
  onStart?: () => Promise<void>;
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
    this.options = options;
  }

  get state(): ExecutionState { return this.current; }
  get blocked(): boolean { return this.current === "stopped" || this.options.durationMs !== undefined && this.current === "armed"; }

  async start(): Promise<void> {
    if (this.current === "stopped") throw new Error("Execution has stopped; restart the host for another run.");
    if (this.starting) { await this.starting; return; }
    if (this.current === "running") { await this.nudge(); return; }
    for (const { id, configuration } of this.options.participants()) {
      if (!configuration.repeatPrompt) continue;
      this.members.set(id, { prompt: configuration.repeatPrompt, continuous: configuration.mode === "continuous",
        delay: configuration.repeatDelayMs ?? this.options.repeatDelayMs ?? 1000, pending: false, generation: 0 });
    }
    this.current = "running";
    this.options.changed(this.current);
    if (this.options.durationMs !== undefined) this.deadline = setTimeout(() => {
      void this.stop().catch(error => this.options.log(`Execution stop failed: ${String(error)}`));
    }, this.options.durationMs);
    this.starting = (async () => {
      await this.options.onStart?.();
      if (this.current === "running") await this.nudge();
    })();
    try { await this.starting; }
    catch (error) { await this.stop(); throw error; }
    finally { this.starting = undefined; }
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
    try { await this.options.prompt(id, member.prompt, scheduleId, current); }
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
    this.options.changed(this.current);
    this.stopping = (async () => {
      // Stop sampling and capture the live page before cancellation can destroy
      // its runtime. The host also starts its cleanup deadline in this hook.
      try { await this.options.onStop?.(); }
      finally { await this.options.cancel(); }
    })();
    return this.stopping;
  }
}
