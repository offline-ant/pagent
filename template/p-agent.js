import { clone, installRoot, readState, writeState } from "./dom.js";
import { connection } from "./agent-connection.js";
import { installControls, refreshControls } from "./agent-controls.js";

const messageText = message => typeof message?.content === "string" ? message.content : (message?.content ?? []).filter(part => part.type === "text").map(part => part.text).join("\n");
const terminal = run => run && ["complete", "cancelled", "error"].includes(run.status);

/** One ordinary page element owns one conversation and independent inference. */
export class PAgent extends HTMLElement {
  static observedAttributes = ["id", "model", "system-prompt", "tools", "mode", "repeat-prompt", "repeat-delay", "persist-start", "persist-end", "public-html"];

  connectedCallback() {
    // An authoritative ancestor may already have rejected this parsed subtree.
    if (!this.isConnected) return;
    const root = installRoot(this, `
      <header class="agent-heading">
        <span class="agent-badge"></span><span class="status" data-status="disconnected">Connecting</span>
        <div class="agent-actions"><button data-save>Save</button><button data-reload>Reload</button><button class="stop" data-cancel>Stop</button></div>
        <label>Web backend <select data-web-backend aria-label="Web backend"><option value="">Use default</option><option value="auto">Auto</option><option value="codex">Codex</option><option value="browser">Browser</option></select> <span data-web-backend-state role="status"></span></label>
        <span class="model"></span>
      </header>
      <p class="notice" role="status"></p>
      <p data-web-progress role="status" hidden></p>
      <section data-web-attention role="status" hidden>
        <p data-web-reason></p><p><a data-web-url target="_blank" rel="noopener noreferrer"></a></p>
        <p>Use the controlled research browser window, then continue here.</p>
        <button data-web-continue>Continue</button> <button data-web-cancel>Cancel</button>
      </section><slot></slot>`, {
      activeId: null, busy: false, model: "", notice: "", error: false,
      run: null, result: ""
    });
    this.state = readState(root);
    this.connected ??= false;
    this.webAttention ??= null;
    this.webResponding ??= false;
    this.webProgress ??= "";
    this.webBackend ??= null;
    this.listeners?.abort();
    this.listeners = new AbortController();
    installControls(this);
    if (!this.inputs.length) this.addInput();
    try { connection.attach(this); }
    catch (error) { this.notice(error instanceof Error ? error.message : String(error), true); }
    this.refresh();
  }

  disconnectedCallback() {
    this.listeners?.abort();
    connection.detach(this);
  }

  attributeChangedCallback(name, previous, value) {
    if (!connection.registered(this) || previous === value || this.restoringAttribute) return;
    this.restoringAttribute = true;
    if (previous === null) this.removeAttribute(name); else this.setAttribute(name, previous);
    this.restoringAttribute = false;
    this.notice(name === "id" ? "An attached agent cannot be renamed; create a new p-agent instead." : "Agent configuration is pinned while registered; dispose it and wait for acknowledgment before changing settings.", true);
  }

  get configuration() {
    const configuration = { agentId: this.id };
    for (const [attribute, key] of [["model", "model"], ["system-prompt", "systemPrompt"], ["mode", "mode"], ["repeat-prompt", "repeatPrompt"]]) {
      if (this.hasAttribute(attribute)) configuration[key] = this.getAttribute(attribute);
    }
    if (this.hasAttribute("tools")) configuration.tools = this.getAttribute("tools").split(",").map(name => name.trim()).filter(Boolean);
    if (this.hasAttribute("repeat-delay")) configuration.repeatDelayMs = Number(this.getAttribute("repeat-delay"));
    return configuration;
  }

  get canSubmit() {
    if (!this.connected || this.state.busy || connection.reloading || connection.executionState === "stopped") return false;
    try { connection.validate(this); return true; } catch { return false; }
  }
  get status() {
    if (!this.connected) return "disconnected";
    if (this.webAttention || this.state.busy && this.state.run?.status === "waiting") return "waiting";
    if (this.state.busy) return "running";
    return this.state.run?.status === "error" ? "error" : "idle";
  }
  get inputs() { return [...this.querySelectorAll("user-input")].filter(node => node.closest("p-agent") === this); }
  get outputs() { return [...this.querySelectorAll("agent-output")].filter(node => node.closest("p-agent") === this); }
  get result() { return this.state.result; }
  get run() { return clone(this.state.run); }
  get messages() { return this.collectHistory(); }
  get lastSeq() { return connection.lastSeq; }

  send(request) {
    try { connection.send(request); return true; }
    catch (error) { this.notice(error instanceof Error ? error.message : String(error), true); return false; }
  }

  notice(text, error = false) {
    this.state.notice = text;
    this.state.error = error;
    this.refresh();
  }

  addInput(before) {
    const input = document.createElement("user-input");
    input.id = `prompt-${crypto.randomUUID()}`;
    if (before) before.before(input);
    else this.append(input);
    return input;
  }

  ensureTurn(id) {
    let input = this.inputs.find(node => node.id === id);
    if (!input) {
      input = document.createElement("user-input");
      input.id = id;
      this.append(input);
    }
    let output = this.outputs.find(node => node.getAttribute("for") === id);
    if (!output) {
      output = document.createElement("agent-output");
      output.setAttribute("for", id);
      input.after(output);
    }
    return { input, output };
  }

  assertSubmittable() {
    if (!this.isConnected) throw new Error("Attach the p-agent to the document before prompting it.");
    connection.validate(this);
    if (!this.connected) throw new Error("The native connection is not ready.");
    if (connection.reloading) throw new Error("Wait for workspace reload to finish before submitting.");
    if (connection.executionState === "stopped") throw new Error("Execution has stopped; restart the host for another run.");
    if (this.state.busy) throw new Error("Agent is busy. Wait for this response or cancel it before submitting.");
  }

  // scheduleId is supplied only by the host's repeat controller. It grants no
  // authority: the host consumes it once and rejects stale queued submissions.
  prompt(text, scheduleId) {
    this.assertSubmittable();
    if (typeof text !== "string" || !text.trim()) throw new Error("Prompt must be a nonempty string.");
    // Programmatic turns precede trailing human drafts, so their later submission
    // includes this response without moving or replacing the human's editor.
    let before;
    for (const input of this.inputs.toReversed()) {
      if (input.submittedMessage) break;
      before = input;
    }
    const input = this.addInput(before);
    input.value = text;
    return this.submit(input.id, scheduleId);
  }

  submit(id, scheduleId) {
    this.assertSubmittable();
    const input = this.inputs.find(node => node.id === id);
    if (!input) throw new Error(`No user-input with id ${id} in agent ${this.id}`);
    if (input.submittedMessage) throw new Error("This message was already submitted. Write a new prompt to continue.");
    const prompt = input.value;
    if (!prompt.trim()) throw new Error("Write a prompt before submitting.");
    // A draft may precede turns submitted since it was written. Move only this
    // input after the latest turn so recorded history stays chronological.
    const last = this.inputs.findLast(node => node.submittedMessage);
    if (last && input.compareDocumentPosition(last) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const previous = this.outputs.find(node => node.getAttribute("for") === last.id) ?? last;
      previous.after(input);
    }
    const { output } = this.ensureTurn(id);
    input.acceptUser({ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() });
    const runId = `run-${crypto.randomUUID()}`;
    this.state.activeId = id;
    this.state.busy = true;
    this.state.notice = "";
    this.state.error = false;
    this.state.run = { id: runId, agentId: this.identity, inputId: id, status: "running", result: "" };
    this.pendingRunId = runId;
    output.apply({ type: "status", status: "running" });
    this.refresh();
    try { connection.send({ type: "submit", agentId: this.identity, id, runId, ...(scheduleId === undefined ? {} : { scheduleId }) }); }
    catch (error) {
      this.finish({ ...this.state.run, status: "error", error: error instanceof Error ? error.message : String(error) });
      throw error;
    }
    return runId;
  }

  dispose() { connection.dispose(this); }

  cancel() {
    if (!this.connected || !this.state.busy) return false;
    return this.send({ type: "cancel", agentId: this.identity });
  }

  finish(run) {
    const output = this.outputs.find(node => node.getAttribute("for") === run.inputId);
    if (output) {
      output.state.status = run.status;
      output.persist();
    }
    this.state.run = clone(run);
    this.pendingRunId = undefined;
    this.state.busy = false;
    this.state.activeId = null;
    if (run.status === "complete") this.state.result = run.result;
    if (run.error) {
      this.state.notice = run.error;
      this.state.error = true;
    }
    this.webAttention = null;
    this.webResponding = false;
    this.webProgress = "";
    if (!this.inputs.some(input => !input.submittedMessage)) this.addInput();
    this.refresh();
    this.dispatchEvent(new CustomEvent("complete", { detail: clone(run) }));
  }

  collectHistory(selected) {
    const history = [];
    for (const input of this.inputs) {
      if (input === selected) continue;
      if (input.submittedMessage) history.push(input.submittedMessage);
      const output = this.outputs.find(node => node.getAttribute("for") === input.id);
      if (output) history.push(...output.messages);
    }
    return history;
  }

  receive(record) {
    const event = record.event;
    // Local submission stores the run before sending. A checkpoint can therefore
    // already contain a newer run than the first terminal records in its replay.
    // Apply the same scope check to every run event, not only message/tool output.
    if (event.run && (event.run.agentId !== this.identity || record.runId && record.runId !== event.run.id || record.requestId && record.requestId !== event.run.inputId)) return;
    const runId = record.runId ?? event.run?.id;
    if (event.type !== "connected" && runId) {
      if (this.state.run && this.state.run.id !== runId) return;
      if (!this.state.run && event.type !== "run") return;
      if (record.requestId && this.state.run && record.requestId !== this.state.run.inputId) return;
      // Terminal records are final; delayed progress cannot revive their run.
      if (terminal(this.state.run) && event.type !== "run") return;
      if (terminal(this.state.run) && event.type === "run" && !terminal(event.run)) return;
    }
    if (event.type === "connected") {
      this.connected = true;
      this.webBackend = null;
      this.webAttention = null;
      this.webResponding = false;
      this.state.model = event.model;
      this.allowedTools = event.tools;
      if (event.run && (!this.pendingRunId || event.run.id === this.pendingRunId)) {
        this.pendingRunId = undefined;
        if (terminal(event.run)) {
          if (!terminal(this.state.run) || this.state.run.id !== event.run.id) this.finish(event.run);
          else this.state.run = clone(event.run);
        } else {
          this.state.run = clone(event.run);
          this.state.activeId = event.run.inputId;
        }
      } else if (this.state.busy && !event.busy && this.state.run && !this.pendingRunId) {
        this.finish({ ...this.state.run, status: "cancelled", error: "Run interrupted by host restart; submit explicitly to continue." });
      }
      // A registration acknowledgement may precede the just-sent submission.
      // Pending submission is runtime-only; restored HTML never implies a retry.
      this.state.busy = event.busy || Boolean(this.pendingRunId);
    } else if (event.type === "backend-state") {
      this.webBackend = event.state;
    } else if (event.type === "web-attention") {
      this.webAttention = event.request;
      this.webResponding = false;
    } else if (event.type === "web-progress") {
      this.webProgress = event.message;
    } else if (event.type === "saved") {
      this.state.notice = `Saved · ${event.revision}`;
      this.state.error = false;
    } else if (event.type === "run") {
      const run = event.run;
      if (this.pendingRunId === run.id) this.pendingRunId = undefined;
      if (terminal(run)) {
        if (!terminal(this.state.run) || this.state.run.id !== run.id) this.finish(run);
      } else {
        this.state.run = clone(run);
        this.state.activeId = run.inputId;
        this.state.busy = true;
        this.ensureTurn(run.inputId).output.apply({ type: "status", status: "running" }, record.seq);
      }
    } else if (event.type === "status") {
      if (event.model) this.state.model = event.model;
      if (event.status === "running") {
        this.state.busy = true;
        this.state.activeId = record.requestId ?? this.state.activeId;
        if (this.state.activeId) this.ensureTurn(this.state.activeId).output.apply(event, record.seq);
      }
      // Only the matching terminal run record confirms completion, not SDK idle.
    } else if (event.type === "error") {
      const id = record.requestId ?? this.state.activeId;
      if (record.agentId && id) this.ensureTurn(id).output.apply(event, record.seq);
      this.state.notice = event.message;
      this.state.error = true;
    } else if (event.type === "message" || event.type === "tool") {
      const id = record.requestId ?? this.state.activeId;
      if (id) {
        const { input, output } = this.ensureTurn(id);
        if (event.type === "message" && event.message?.role === "user") {
          if (!input.value) input.value = messageText(event.message);
          if (event.phase === "end") input.acceptUser(event.message);
        } else output.apply(event, record.seq);
      }
    }
    this.refresh();
    this.dispatchEvent(new CustomEvent("progress", { detail: clone(record) }));
  }

  refresh() {
    if (!this.state || !this.shadowRoot) return;
    writeState(this.shadowRoot, this.state);
    refreshControls(this);
    for (const input of this.inputs) if (input.state) input.refresh();
  }
}
