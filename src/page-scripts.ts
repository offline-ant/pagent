import type { HostEvent } from "./protocol.ts";
import { agentConsoleEntries } from "./agent-console.ts";

/** Shared durable HTML representation across browser protocols. */
export const SNAPSHOT_EXPRESSION = `(() => {
  const root = document.documentElement;
  if (!root) throw new Error("Document has no root element");
  const doctype = document.doctype ? new XMLSerializer().serializeToString(document.doctype) + "\\n" : "";
  const shell = root.cloneNode(false).outerHTML;
  const closing = shell.lastIndexOf("</");
  return doctype + shell.slice(0, closing) + root.getHTML({serializableShadowRoots:true}) + shell.slice(closing);
})()`;

/** Evaluate separately with sourceURL=pagent-agent-mirror, without CSP-blocked dynamic compilation. */
export function mirrorExpression(event: HostEvent): string {
  return `(() => {
    const cursor = Symbol.for('pagent.console-sequence');
    if (typeof globalThis[cursor] !== 'number' || ${event.seq} > globalThis[cursor]) {
      const entries = JSON.parse(${JSON.stringify(JSON.stringify(agentConsoleEntries(event)))});
      for (const entry of entries) console[entry.level](entry.text);
      globalThis[cursor] = ${event.seq};
    }
  })()`;
}

export function deliveryExpression(event: HostEvent): string {
  // JSON data is not an object literal: __proto__ must remain an own data property.
  return `(() => {
    if (!globalThis.aos || typeof globalThis.aos.dispatchEvent !== "function") throw new Error("Page native event port was removed; reload or repair it");
    const detail = JSON.parse(${JSON.stringify(JSON.stringify(event))});
    let acknowledged = false;
    const delivery = new CustomEvent("event", {detail});
    delivery.ack = () => { acknowledged = true; };
    globalThis.aos.dispatchEvent(delivery);
    if (!acknowledged) throw new Error("Page did not acknowledge native event delivery; repair the receiver and retry");
  })()`;
}
