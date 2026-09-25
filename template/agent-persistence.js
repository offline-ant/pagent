/* Persistence retains live elements, never copies or a second conversation store. */
const configurations = new WeakMap();
const voidTags = new Set(["AREA", "BASE", "BR", "COL", "EMBED", "HR", "IMG", "INPUT", "LINK", "META", "PARAM", "SOURCE", "TRACK", "WBR"]);

function validTarget(agent, target) {
  if (!(target instanceof HTMLElement) || voidTags.has(target.tagName) || !target.isConnected || target.ownerDocument !== document || agent.contains(target)) {
    throw new Error(`Agent ${agent.id} persistence target must be a connected HTML container outside its own subtree.`);
  }
  return target;
}

function targetFor(agent, configuration, warn) {
  let target = document.querySelector(configuration.selector);
  if (!target) {
    if (warn) console.warn(`Agent ${agent.id} persistence target ${configuration.selector} is missing; falling back to document.body.`);
    target = document.body;
  }
  return validTarget(agent, target);
}

export function pinPersistence(agent) {
  const edges = ["start", "end"].filter(edge => agent.hasAttribute(`persist-${edge}`));
  if (edges.length > 1) throw new Error("Use only one of persist-start and persist-end.");
  if (!edges.length) { configurations.delete(agent); return; }
  const edge = edges[0];
  const selector = agent.getAttribute(`persist-${edge}`).trim();
  if (!selector) throw new Error("Agent persistence requires a nonempty CSS selector.");
  const configuration = { edge, selector };
  targetFor(agent, configuration, false); // Also checks selector syntax before registration.
  configurations.set(agent, configuration);
}

export function isPersistent(agent) { return configurations.has(agent); }
export function releasePersistence(agent) { configurations.delete(agent); }

/** Registration order, except an ancestor must recover before its descendants. */
export function restoreAgents(agents, eligible, fail) {
  const pending = new Set(agents);
  const anchors = new Map();
  function restore(agent) {
    if (!pending.delete(agent)) return;
    for (let parent = agent.parentElement; parent; parent = parent.parentElement) {
      if (pending.has(parent)) restore(parent);
    }
    if (agent.isConnected || !eligible(agent)) return;
    const configuration = configurations.get(agent);
    if (!configuration) return;
    try {
      // Parsed replacements are removed by attach; never remove arbitrary artwork.
      if ([...document.querySelectorAll("[id]")].some(node => node !== agent && node.id === agent.id)) {
        throw new Error(`Agent ${agent.id} persistence failed: duplicate id in the current document.`);
      }
      const target = targetFor(agent, configuration, true);
      if (configuration.edge === "start") {
        if (!anchors.has(target)) anchors.set(target, target.firstChild);
        target.insertBefore(agent, anchors.get(target));
      } else target.append(agent);
      if (!agent.isConnected) throw new Error(`Agent ${agent.id} was disconnected during restoration.`);
    } catch (error) { fail(agent, error); }
  }
  for (const agent of agents) restore(agent);
}
