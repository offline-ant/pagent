/* One page transport and replay cursor; inference identities belong to elements. */
const identities = new Map();

export const connection = {
  started: false,
  live: false,
  busy: false,
  reloading: false,
  get agents() { return [...document.querySelectorAll("p-agent")]; },
  get lastSeq() { return Number(document.documentElement.dataset.pagentSeq ?? 0); },

  send(request) {
    if (!window.aos) throw new Error("No native connection. Open this workspace in its controlled browser tab.");
    window.aos.send(request);
  },

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
    this.validate(agent);
    if (identities.get(agent.id) === agent) return;
    agent.identity = agent.id;
    identities.set(agent.id, agent);
    if (this.started) {
      agent.connected = this.live;
      this.send({ type: "register", agentId: agent.id });
    }
  },

  detach(agent) {
    // Ordinary DOM moves disconnect/reconnect within the same task.
    queueMicrotask(() => {
      if (agent.isConnected || agent.closing || identities.get(agent.identity) !== agent) return;
      agent.connected = false;
      if (this.started) {
        agent.closing = true;
        this.send({ type: "dispose", agentId: agent.identity });
      } else identities.delete(agent.identity);
    });
  },

  receive(record) {
    if (!Number.isSafeInteger(record?.seq) || record.seq <= 0 || !record.event || typeof record.event.type !== "string" || !record.event.type) {
      throw new Error("Invalid native event record.");
    }
    if (record.seq <= this.lastSeq) return;
    const event = record.event;
    if (event.type === "connected") this.live = true;
    if (event.type === "workspace-state") {
      this.live = true;
      this.busy = event.busy;
      this.reloading = Boolean(event.reloading);
    }
    // Disposal is an identity acknowledgment, not an event for a replacement element.
    if (event.type === "disposed") {
      const agent = identities.get(record.agentId);
      if (agent?.closing) {
        identities.delete(record.agentId);
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
      for (const agent of this.agents) agent.notice("Open this workspace in its controlled browser tab to connect. This saved document is still readable and editable.", true);
      return;
    }
    const after = this.lastSeq;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error("Invalid saved page event cursor.");
    window.aos.addEventListener("event", event => {
      this.receive(event.detail);
      event.ack();
    });
    this.started = true;
    this.send({ type: "ready", after, agents: [...identities.keys()] });
  }
};
