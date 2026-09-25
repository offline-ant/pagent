import { clone, element, installRoot, readState, writeState } from "./dom.js";
import { completedParagraphs } from "./paragraphs.js";

const pretty = value => typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "undefined";
const paragraphKey = ({ messageIndex, partIndex, paragraphIndex }) => `${messageIndex}:${partIndex}:${paragraphIndex}`;

function renderContent(content) {
  const fragment = document.createDocumentFragment();
  for (const part of Array.isArray(content) ? content : [content]) {
    if (part?.type === "image") {
      // Raster data only: no SVG, external URLs, markup, or unbounded base64 dumps.
      if (typeof part.mimeType !== "string" || !/^image\/(png|jpeg|gif|webp)$/.test(part.mimeType) ||
        typeof part.data !== "string" || !part.data.length || part.data.length > 4 * Math.ceil(4 * 1024 * 1024 / 3) ||
        part.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(part.data)) {
        fragment.append(element("p", "error-message", "Image unavailable: unsupported MIME, invalid base64, or exceeds 4 MiB."));
        continue;
      }
      const image = element("img", "message-image");
      image.src = `data:${part.mimeType};base64,${part.data}`;
      image.alt = "Tool image";
      image.style.maxWidth = "100%";
      image.style.height = "auto";
      fragment.append(image);
    } else fragment.append(element("pre", "", part?.type === "text" ? part.text : pretty(part)));
  }
  return fragment;
}

export class AgentOutput extends HTMLElement {
  connectedCallback() {
    const root = installRoot(this, '<section class="response" aria-label="Agent response" aria-live="polite"></section>', {
      messages: [], partial: null, tools: [], errors: [], paragraphs: [], status: "waiting"
    });
    this.state = readState(root);
    this.persist();
  }

  get messages() { return clone(this.state.messages); }
  get tools() {
    return this.state.tools.map(tool => {
      const result = this.state.messages.find(message => message.role === "toolResult" && message.toolCallId === tool.callId);
      return clone(result ? { ...tool, result: { content: result.content, details: result.details } } : tool);
    });
  }
  get paragraphs() { return clone(this.state.paragraphs).reverse(); }

  // Messages own text and order; this cache owns only first-completion times.
  // Reconcile on persist so intentional edits to page-owned history also appear.
  reconcileParagraphs() {
    const previous = new Map(this.state.paragraphs.map(item => [paragraphKey(item), item]));
    const timestamp = Date.now();
    const paragraphs = [];
    const messages = [...this.state.messages, ...(this.state.partial ? [this.state.partial] : [])];
    messages.forEach((message, messageIndex) => {
      if (message.role !== "assistant") return;
      const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
      parts.forEach((part, partIndex) => {
        if (part.type !== "text") return;
        completedParagraphs(part.text, messageIndex < this.state.messages.length).forEach((text, paragraphIndex) => {
          const paragraph = { messageIndex, partIndex, paragraphIndex, text };
          const existing = previous.get(paragraphKey(paragraph));
          paragraphs.push({ ...paragraph, timestamp: existing?.timestamp ?? timestamp });
        });
      });
    });
    this.state.paragraphs = paragraphs;
  }

  apply(event, sequence) {
    // Rendering can fail after semantic records were persisted. Retrying an
    // unacknowledged delivery must rebuild the display, not append its message twice.
    if (sequence !== undefined && sequence <= (this.state.lastSeq ?? 0)) {
      this.persist();
      return;
    }
    if (event.type === "message" && event.message?.role !== "user") {
      if (event.phase === "end") {
        this.state.messages.push(clone(event.message));
        this.state.partial = null;
      } else {
        this.state.partial = clone(event.message);
      }
    } else if (event.type === "tool") {
      let tool = this.state.tools.find(item => item.callId === event.callId);
      if (!tool) {
        tool = { callId: event.callId, name: event.name };
        this.state.tools.push(tool);
      }
      Object.assign(tool, clone(event));
    } else if (event.type === "error") {
      this.state.errors.push(event.message);
    } else if (event.type === "status") {
      this.state.status = event.status === "idle" ? "complete" : "running";
    }
    if (sequence !== undefined) this.state.lastSeq = sequence;
    this.persist();
  }

  persist() {
    // Final messages own tool content. Avoid a second base64 copy in saved UI state.
    for (const tool of this.state.tools) {
      if (this.state.messages.some(message => message.role === "toolResult" && message.toolCallId === tool.callId)) delete tool.result;
    }
    this.reconcileParagraphs();
    this.setAttribute("status", this.state.status);
    writeState(this.shadowRoot, this.state);
    this.render();
  }

  renderTool(call, result) {
    const live = this.state.tools.find(item => item.callId === call.id);
    const isError = live?.isError || result?.isError;
    const details = element("details", `tool${isError ? " error" : ""}`);
    details.dataset.callId = call.id;
    const summary = element("summary", "", call.name ?? live?.name ?? "Tool");
    summary.append(element("span", "tool-state", isError ? "error" : live?.phase === "end" || result ? "complete" : "running"));
    const body = element("div", "tool-body");
    body.append(element("span", "tool-section", "Arguments"), element("pre", "", pretty(call.arguments ?? live?.args)));
    const output = result?.content ?? live?.result?.content ?? live?.result;
    if (output !== undefined) body.append(element("span", "tool-section", "Result"), renderContent(output));
    details.append(summary, body);
    return details;
  }

  render() {
    const response = this.shadowRoot.querySelector(".response");
    // Preserve the human's disclosure choices across streaming updates.
    const opened = new Set([...response.querySelectorAll("details[open]")].map(node => node.dataset.key ?? node.dataset.callId));
    let list = response.querySelector(".paragraphs");
    if (!list) {
      const heading = element("div", "response-heading");
      heading.append(element("span", "eyebrow", "Agent"), element("span", "response-state"));
      list = element("div", "paragraphs");
      response.replaceChildren(heading, list, element("div", "response-details"));
    }
    let loading = response.querySelector(".paragraph-loading");
    if (!loading) {
      loading = element("span", "paragraph-loading");
      loading.setAttribute("role", "status");
      loading.setAttribute("aria-label", "Generating response");
      list.before(loading);
    }
    loading.hidden = this.state.status !== "running";
    const status = response.querySelector(".response-state");
    if (status.textContent !== this.state.status) status.textContent = this.state.status;
    const blocks = new Map([...list.children].map(node => [node.dataset.key, node]));
    const publicBlocks = new Map([...this.children].filter(node => node.hasAttribute("data-pagent-public-paragraph")).map(node => [node.dataset.key, node]));
    const publicKeys = new Set();
    const publicHTML = this.closest("p-agent")?.hasAttribute("public-html");
    let cursor = list.firstChild;
    for (const paragraph of this.paragraphs) {
      const key = paragraphKey(paragraph);
      const message = this.state.messages[paragraph.messageIndex];
      // Only successfully completed final prose becomes ordinary page content.
      // Streaming, tool-call commentary, failures and all non-text records stay in shadow DOM.
      const isPublic = publicHTML && message?.role === "assistant" && message.stopReason === "stop" &&
        !(Array.isArray(message.content) && message.content.some(part => part.type === "toolCall"));
      let node = blocks.get(key);
      let block = node?.localName === "slot" ? publicBlocks.get(key) : node;
      if (!block) {
        block = element("div", "paragraph");
        block.dataset.key = key;
        block.append(element("time", "paragraph-time"), element("div", "paragraph-text"));
      }
      if (isPublic) {
        publicKeys.add(key);
        const name = `public-paragraph-${key}`;
        block.slot = name;
        block.setAttribute("data-pagent-public-paragraph", "");
        if (block.parentNode !== this) {
          if (cursor === block) cursor = block.nextSibling;
          this.append(block);
        }
        if (node?.localName !== "slot") {
          node = element("slot");
          node.name = name;
          node.dataset.key = key;
        }
      } else {
        block.removeAttribute("slot");
        block.removeAttribute("data-pagent-public-paragraph");
        if (node?.localName === "slot") {
          if (cursor === node) cursor = node.nextSibling;
          node.remove();
        }
        node = block;
      }
      const text = block.querySelector(".paragraph-text");
      if (text.textContent !== paragraph.text) text.textContent = paragraph.text;
      const date = new Date(paragraph.timestamp);
      const time = block.querySelector("time");
      if (time.dateTime !== date.toISOString()) {
        time.dateTime = date.toISOString();
        time.textContent = date.toLocaleTimeString();
        time.title = date.toLocaleString();
      }
      // Prepend new completions without detaching the text being read/selected.
      if (node === cursor) cursor = cursor.nextSibling;
      else list.insertBefore(node, cursor);
    }
    while (cursor) {
      const next = cursor.nextSibling;
      cursor.remove();
      cursor = next;
    }
    for (const [key, block] of publicBlocks) if (!publicKeys.has(key) && block.parentNode === this) block.remove();
    // Keep ordinary DOM traversal in the same newest-first order as the slotted display.
    let publicCursor = this.querySelector(":scope > [data-pagent-public-paragraph]");
    for (const key of publicKeys) {
      const block = this.querySelector(`:scope > [data-pagent-public-paragraph][data-key="${key}"]`);
      if (block === publicCursor) publicCursor = publicCursor.nextElementSibling;
      else this.insertBefore(block, publicCursor);
    }
    const fragment = document.createDocumentFragment();
    const messages = [...this.state.messages, ...(this.state.partial ? [this.state.partial] : [])];
    const shownTools = new Set();
    messages.forEach((message, messageIndex) => {
      if (message.role !== "assistant") return;
      const block = element("section", "message");
      const parts = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content ?? [];
      parts.forEach((part, partIndex) => {
        if (part.type === "thinking" && part.thinking) {
          const details = element("details", "reasoning");
          details.dataset.key = `thinking-${messageIndex}-${partIndex}`;
          details.append(element("summary", "", "Reasoning"), element("div", "prose", part.thinking));
          block.append(details);
        }
        if (part.type === "toolCall") {
          const result = messages.find(item => item.role === "toolResult" && item.toolCallId === part.id);
          shownTools.add(part.id);
          block.append(this.renderTool(part, result));
        }
        if (part.type === "image") block.append(renderContent([part]));
      });
      if (message.errorMessage) block.append(element("p", "error-message", message.errorMessage));
      if (block.childNodes.length) fragment.append(block);
    });
    // Tool events may arrive before the complete assistant message.
    for (const tool of this.state.tools) {
      if (!shownTools.has(tool.callId)) {
        const result = messages.find(message => message.role === "toolResult" && message.toolCallId === tool.callId);
        fragment.append(this.renderTool({ id: tool.callId, name: tool.name, arguments: tool.args }, result));
      }
    }
    for (const error of this.state.errors) fragment.append(element("p", "error-message", error));
    response.querySelector(".response-details").replaceChildren(fragment);
    for (const details of response.querySelectorAll("details")) {
      details.open = opened.has(details.dataset.key ?? details.dataset.callId);
    }
  }
}
