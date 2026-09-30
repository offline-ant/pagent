import { isPersistent, pinPersistence, releasePersistence, restoreAgents } from "./agent-persistence.js";

/* One page transport and replay cursor; inference identities belong to elements. */
const identities = new Map();
let reconciliationPending = false;
let tearingDown = false;
// beforeunload is only an attempted navigation: a human may cancel it.
window.addEventListener("pagehide", () => { tearingDown = true; });

export const connection = {
  started: false,
  live: false,
  busy: false,
  reloading: false,
  executionState: "armed",
  get agents() { return [...document.querySelectorAll("p-agent")]; },
  get lastSeq() { return Number(document.documentElement.dataset.pagentSeq ?? 0); },

  send(request) {
    if (!window.aos) throw new Error("No native connection. Open this workspace in its controlled browser tab.");
    // A page stop takes effect before the next microtask, not its host echo.
    if (request.type === "stop") this.executionState = "stopped";
    window.aos.send(request);
  },

  registered(agent) { return identities.get(agent.identity) === agent; },
  get canRestore() { return !tearingDown && !this.reloading && this.executionState !== "stopped"; },

  validate(agent) {
    if (!agent.id || agent.id.length > 200 || /[\s\u0000-\u001f\u007f]/u.test(agent.id)) {
      throw new Error("p-agent requires a unique nonempty id (at most 200 characters, without whitespace or controls).");
    }
    const reserved = identities.get(agent.id);
    if (reserved?.closing) throw new Error(`Agent ${agent.id} is still being disposed. Wait for acknowledgment, then remove and reinsert the element.`);
    if (reserved && reserved !== agent || [...document.querySelectorAll("[id]")].some(node => node !== agent && node.id === agent.id)) {
      throw new Error(`Duplicate agent id: ${agent.id}`);
    }
    if (agent.identity && agent.identity !== agent.id) throw new Error("An attached agent cannot be renamed; create a new p-agent instead.");
  },

  attach(agent) {
    const original = identities.get(agent.id);
    if (original && original !== agent && !original.closing && isPersistent(original)) {
      // innerHTML reparses light DOM but not its live conversations. The registered
      // original owns this ID; a freshly parsed replacement must never register.
      agent.remove();
      throw new Error(`Duplicate agent id: ${agent.id}; retained the registered persistent element.`);
    }
    this.validate(agent);
    if (original === agent) return;
    // Invalid declarations must not reserve an identity or poison the ready list.
    const configuration = agent.configuration;
    pinPersistence(agent);
    agent.identity = agent.id;
    identities.set(agent.id, agent);
    if (this.started) {
      agent.connected = this.live;
      this.send({ type: "register", ...configuration });
    }
  },

  release(agent) {
    identities.delete(agent.identity);
    releasePersistence(agent);
    agent.identity = undefined;
  },

  retire(agent) {
    if (agent.closing || !this.registered(agent)) return;
    agent.connected = false;
    if (this.started) {
      agent.closing = true;
      this.send({ type: "dispose", agentId: agent.identity });
    } else this.release(agent);
  },

  dispose(agent) {
    agent.remove();
    // Independent persistent descendants can still recover in the shared batch.
    this.retire(agent);
  },

  detach(agent) {
    if (!this.registered(agent) || reconciliationPending) return;
    reconciliationPending = true;
    // One grace microtask also permits moves completed by a queued microtask.
    queueMicrotask(() => queueMicrotask(() => {
      try {
        const detached = [...identities.values()].filter(agent => !agent.isConnected && !agent.closing);
        restoreAgents(detached, agent => this.canRestore && !agent.closing, (agent, error) => {
          const message = error instanceof Error ? error.message : String(error);
          console.error(message);
          agent.notice(message, true);
        });
        for (const agent of detached) if (!agent.isConnected) this.retire(agent);
      } finally { reconciliationPending = false; }
    }));
  },

  receive(record) {
    if (!Number.isSafeInteger(record?.seq) || record.seq <= 0 || !record.event || typeof record.event.type !== "string" || !record.event.type) {
      throw new Error("Invalid native event record.");
    }
    if (record.seq <= this.lastSeq) return;
    const event = record.event;
    if (event.type === "connected") this.live = true;
    if (event.type === "execution-state") this.executionState = event.state;
    if (event.type === "workspace-state") {
      this.live = true;
      this.busy = event.busy;
      this.reloading = Boolean(event.reloading);
    }
    // Disposal is an identity acknowledgment, not an event for a replacement element.
    if (event.type === "disposed") {
      const agent = identities.get(record.agentId);
      if (agent?.closing) {
        this.release(agent);
        agent.closing = false;
        if (agent.state.busy && agent.state.run) agent.finish({ ...agent.state.run, status: "cancelled" });
      }
    } else {
      const recipients = record.agentId ? [identities.get(record.agentId)] : [...identities.values()];
      for (const agent of recipients) if (agent?.isConnected && !agent.closing) agent.receive(record);
    }
    for (const agent of this.agents) agent.refresh();
    document.documentElement.dataset.pagentSeq = String(record.seq);
  },

  connect() {
    if (this.started) return;
    if (!window.aos) {
      for (const agent of identities.values()) agent.notice("Open this workspace in its controlled browser tab to connect. This saved document is still readable and editable.", true);
      return;
    }
    const after = this.lastSeq;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid saved page event cursor.");
    window.aos.addEventListener("event", event => {
      this.receive(event.detail);
      event.ack();
    });
    this.started = true;
    this.send({ type: "ready", after, agents: [...identities.values()].map(agent => agent.configuration) });
  }
};
