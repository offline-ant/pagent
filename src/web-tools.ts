import type { WebAttention } from "pi-browser/web";
import type { AgentEvent } from "./protocol.ts";

/** Host-owned intervention state. Page records never authorize stale continuation IDs. */
export class WebAttentionCoordinator {
  private pending?: {
    request: WebAttention;
    settle: (continueOperation: boolean) => void;
  };
  private emit: (event: AgentEvent) => void;

  constructor(emit: (event: AgentEvent) => void) { this.emit = emit; }

  get current(): WebAttention | null { return this.pending ? { ...this.pending.request } : null; }

  wait(request: WebAttention, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    if (this.pending) throw new Error("Another web operation is already waiting for user attention.");
    return new Promise<boolean>((resolve, reject) => {
      const clear = () => {
        signal?.removeEventListener("abort", abort);
        this.pending = undefined;
        this.emit({ type: "web-attention", request: null });
      };
      const abort = () => {
        clear();
        reject(signal?.reason ?? new Error("Web operation cancelled."));
      };
      this.pending = {
        request: { ...request },
        settle: continued => { clear(); resolve(continued); },
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.emit({ type: "web-attention", request: { ...request } });
    });
  }

  respond(id: string, continued: boolean): void {
    if (this.pending?.request.id !== id) throw new Error("This web intervention is no longer active.");
    this.pending.settle(continued);
  }

  cancel(): void { this.pending?.settle(false); }
}
