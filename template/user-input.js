import { clone, installRoot, readState, writeState } from "./dom.js";

export class UserInput extends HTMLElement {
  connectedCallback() {
    const root = installRoot(this, `
      <section class="input-card">
        <div class="input-label"><span>You</span><span data-label>New prompt</span></div>
        <div class="editor" contenteditable="plaintext-only" role="textbox" aria-label="Your prompt" aria-multiline="true"></div>
        <div class="input-actions"><span class="input-hint">Submit explicitly. Editing alone sends nothing.</span><button class="primary" data-submit>Submit</button></div>
      </section>`, { submittedMessage: null });
    this.state = readState(root);
    this.listeners?.abort();
    this.listeners = new AbortController();
    root.querySelector("[data-submit]").addEventListener("click", () => {
      const agent = this.closest("p-agent");
      try { agent?.submit(this.id); }
      catch (error) { agent?.notice(error instanceof Error ? error.message : String(error), true); }
    }, { signal: this.listeners.signal });
    this.refresh();
  }

  disconnectedCallback() { this.listeners?.abort(); }
  get value() { return this.shadowRoot.querySelector(".editor").innerText; }
  set value(value) {
    if (this.state.submittedMessage) throw new Error("Submitted messages are read-only. Write a new prompt to continue.");
    this.shadowRoot.querySelector(".editor").textContent = String(value);
  }
  get submittedMessage() { return clone(this.state.submittedMessage); }

  acceptUser(message) {
    this.state.submittedMessage = clone(message);
    writeState(this.shadowRoot, this.state);
    this.refresh();
  }

  refresh() {
    const submitted = this.state.submittedMessage !== null;
    this.shadowRoot.querySelector("[data-label]").textContent = submitted ? "Submitted" : "New prompt";
    const editor = this.shadowRoot.querySelector(".editor");
    editor.contentEditable = submitted ? "false" : "plaintext-only";
    editor.setAttribute("aria-readonly", String(submitted));
    this.shadowRoot.querySelector(".input-actions").hidden = submitted;
    const button = this.shadowRoot.querySelector("[data-submit]");
    button.hidden = submitted;
    button.disabled = submitted || !this.closest("p-agent")?.canSubmit;
  }
}
