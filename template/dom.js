export const clone = value => structuredClone(value);
const encode = value => JSON.stringify(value).replaceAll("<", "\\u003c");

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function installRoot(host, markup, initialState) {
  // Saved declarative shadow roots already contain their records and markup.
  if (!host.shadowRoot) {
    const root = host.attachShadow({ mode: "open", serializable: true });
    root.innerHTML = `<link rel="stylesheet" href="/agent.css">${markup}<script type="application/json" data-pagent-state></script>`;
    root.querySelector("[data-pagent-state]").textContent = encode(initialState);
  }
  return host.shadowRoot;
}

export function readState(root) {
  return JSON.parse(root.querySelector("[data-pagent-state]").textContent);
}

export function writeState(root, state) {
  root.querySelector("[data-pagent-state]").textContent = encode(state);
}
