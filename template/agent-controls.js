import { connection } from "./agent-connection.js";

export function installControls(agent) {
  const root = agent.shadowRoot;
  const options = { signal: agent.listeners.signal };
  for (const type of ["save", "reload", "cancel"]) {
    root.querySelector(`[data-${type}]`).addEventListener("click", () => {
      if (type === "cancel") agent.cancel();
      else agent.send({ type });
    }, options);
  }
  const backend = root.querySelector("[data-web-backend]");
  backend.addEventListener("change", () => {
    if (agent.connected && agent.webBackend) {
      if (["", "auto", "codex", "browser"].includes(backend.value)) {
        agent.send({ type: "backend-set", override: backend.value || null });
      } else agent.notice("Choose Use default, Auto, Codex, or Browser.", true);
    }
    agent.refresh();
  }, options);
  const attention = root.querySelector("[data-web-attention]");
  for (const type of ["web-continue", "web-cancel"]) {
    attention.querySelector(`[data-${type}]`).addEventListener("click", () => {
      if (!agent.connected || !agent.webAttention || agent.webResponding) return;
      agent.webResponding = true;
      if (!agent.send({ type, agentId: agent.identity, id: agent.webAttention.id })) agent.webResponding = false;
      agent.refresh();
    }, options);
  }
}

export function refreshControls(agent) {
  const root = agent.shadowRoot;
  root.querySelector(".agent-badge").textContent = agent.id;
  const status = root.querySelector(".status");
  status.dataset.status = agent.status;
  status.textContent = connection.reloading ? "Reloading" : agent.status === "waiting" ? "Waiting" : agent.state.busy ? "Working" : agent.connected ? "Ready" : "Connecting";
  root.querySelector(".model").textContent = agent.state.model;
  const backend = root.querySelector("[data-web-backend]");
  backend.value = agent.webBackend?.override ?? "";
  backend.disabled = !agent.connected || !agent.webBackend;
  const labels = { auto: "Auto", codex: "Codex", browser: "Browser" };
  root.querySelector("[data-web-backend-state]").textContent = agent.webBackend ? `${labels[agent.webBackend.effective]} · ${agent.webBackend.source}` : "Connecting";
  backend.title = agent.webBackend ? `Configured default: ${labels[agent.webBackend.configured]}. Changes apply to subsequent web calls; active research is unchanged.` : "Waiting for host backend state.";
  const notice = root.querySelector(".notice");
  notice.textContent = agent.state.notice;
  notice.classList.toggle("error", agent.state.error);
  const attention = root.querySelector("[data-web-attention]");
  attention.hidden = !agent.webAttention;
  attention.querySelector("[data-web-reason]").textContent = agent.webAttention?.reason ?? "";
  const link = attention.querySelector("[data-web-url]");
  link.textContent = agent.webAttention?.url ?? "";
  link.removeAttribute("href");
  if (agent.webAttention) {
    try {
      const url = new URL(agent.webAttention.url);
      if (url.protocol === "http:" || url.protocol === "https:") link.href = url.href;
    } catch { /* Invalid URLs remain inert text. */ }
  }
  for (const type of ["web-continue", "web-cancel"]) {
    attention.querySelector(`[data-${type}]`).disabled = !agent.connected || !agent.webAttention || agent.webResponding;
  }
  const progress = root.querySelector("[data-web-progress]");
  progress.textContent = agent.webProgress;
  progress.hidden = !agent.webProgress;
  root.querySelector("[data-cancel]").disabled = !agent.connected || !agent.state.busy;
  root.querySelector("[data-save]").disabled = !agent.connected;
  root.querySelector("[data-reload]").disabled = !agent.connected;
}
