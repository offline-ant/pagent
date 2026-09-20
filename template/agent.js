/* Editable page policy. No particular element or rendering is required by the host. */
import { UserInput } from "./user-input.js";
import { AgentOutput } from "./agent-output.js";
import { PAgent } from "./p-agent.js";
import { connection } from "./agent-connection.js";

customElements.define("user-input", UserInput);
customElements.define("agent-output", AgentOutput);
customElements.define("p-agent", PAgent);

function collectContext(agentId, inputId) {
  const agent = connection.agents.find(node => node.id === agentId);
  if (!agent) throw new Error(`No p-agent with id ${agentId}. Replace pagent.collectContext when replacing the interface.`);
  connection.validate(agent);
  const selected = inputId === undefined ? undefined : agent.inputs.find(input => input.id === inputId);
  if (inputId !== undefined && !selected) throw new Error(`No user-input with id ${inputId} in agent ${agentId}`);
  const outline = document.body.cloneNode(true);
  for (const node of outline.querySelectorAll("script,style,agent-memory,user-input,agent-output")) node.replaceChildren();
  let markup = outline.outerHTML;
  if (markup.length > 16_000) markup = `${markup.slice(0, 16_000)}\n[Outline truncated at 16000 characters; inspect the live DOM for the rest.]`;
  const context = {
    memory: [...document.querySelectorAll("agent-memory")].filter(node => {
      const owner = node.closest("p-agent");
      return !owner || owner === agent;
    }).map(node => node.innerHTML).join("\n\n"),
    outline: markup,
    history: agent.collectHistory(selected)
  };
  if (selected) context.prompt = selected.value;
  return context;
}

window.pagent = {
  collectContext,
  get agents() { return connection.agents; }
};

connection.connect();
