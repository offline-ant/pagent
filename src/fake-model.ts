import {
  fauxAssistantMessage,
  fauxProvider,
  fauxThinking,
  fauxToolCall,
  getCurrentSystemPrompt,
  getCurrentTools,
  type FauxProviderHandle,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { setTimeout as delay } from "node:timers/promises";

/** Deterministic, local provider exercising the real Pi loop; never performs model network I/O. */
export function createFakeModel(): FauxProviderHandle {
  return fauxProvider({
    provider: "pagent-fake",
    api: "pagent-fake",
    models: [{ id: "local", name: "Local smoke model", reasoning: true }],
    tokenSize: { min: 8, max: 8 },
  });
}

/** What the model effectively receives: current prompt and tools, plus the conversation without system records. */
function inspect(context: TranscriptContext): string {
  return JSON.stringify({
    systemPrompt: getCurrentSystemPrompt(context.messages),
    tools: getCurrentTools(context.messages),
    messages: context.messages.filter(message => message.role !== "system"),
  });
}

export function prepareFakeResponse(fake: FauxProviderHandle, prompt: string): void {
  if (prompt === "/fake-wait") {
    fake.setResponses([async (_context, options) => {
      await delay(60_000, undefined, { signal: options?.signal });
      return fauxAssistantMessage("Wait completed.");
    }]);
    return;
  }
  if (prompt === "/fake-inspect") {
    fake.setResponses([context => fauxAssistantMessage(inspect(context))]);
    return;
  }
  if (prompt.startsWith("/fake-say ")) {
    fake.setResponses([fauxAssistantMessage(prompt.slice("/fake-say ".length))]);
    return;
  }
  if (prompt.startsWith("/fake-console ") || prompt.startsWith("/fake-join ")) {
    const consoleCall = prompt.startsWith("/fake-console ");
    const command = consoleCall ? "console" : "wait";
    const argument = prompt.slice(consoleCall ? "/fake-console ".length : "/fake-join ".length);
    fake.setResponses([
      fauxAssistantMessage(fauxToolCall(command, consoleCall ? { code: argument } : { runs: argument.split(",").map(id => id.trim()) }), { stopReason: "toolUse" }),
      context => fauxAssistantMessage(JSON.stringify(context.messages.findLast(message => message.role === "toolResult"))),
    ]);
    return;
  }
  if (prompt === "/fake-delegate") {
    const code = `(() => {
      const container = document.createElement('div'); document.body.append(container);
      return ['research','review'].map(id => {
        const agent = document.createElement('p-agent'); agent.id = id; container.append(agent);
        return agent.prompt('/fake-console new Promise(resolve => setTimeout(() => { document.body.dataset.' + id + ' = "done"; resolve("' + id + ' answer"); }, 300))');
      });
    })()`;
    fake.setResponses([
      fauxAssistantMessage(fauxToolCall("console", { code }), { stopReason: "toolUse" }),
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        const text = result?.content.find(block => block.type === "text");
        if (!text || result?.isError) throw new Error("Fake delegation spawn failed.");
        const value: unknown = JSON.parse(text.text).value;
        if (!Array.isArray(value) || !value.every(id => typeof id === "string")) throw new Error("Fake delegation did not return run IDs.");
        return fauxAssistantMessage(fauxToolCall("wait", { runs: value }), { stopReason: "toolUse" });
      },
      context => fauxAssistantMessage(JSON.stringify(context.messages.findLast(message => message.role === "toolResult"))),
    ]);
    return;
  }
  if (prompt.startsWith("/fake-fetch ")) {
    const url = new URL(prompt.slice("/fake-fetch ".length).trim());
    if (!["http:", "https:"].includes(url.protocol)) throw new Error("Fake fetch requires an HTTP(S) URL.");
    fake.setResponses([
      fauxAssistantMessage(fauxToolCall("web_fetch", { url: url.href }), { stopReason: "toolUse" }),
      context => fauxAssistantMessage(JSON.stringify({
        tools: getCurrentTools(context.messages).map(tool => ({ name: tool.name })),
        result: context.messages.findLast(message => message.role === "toolResult"),
      })),
    ]);
    return;
  }
  if (prompt === "/fake-web") {
    fake.setResponses([
      fauxAssistantMessage([
        fauxToolCall("web_search", { query: "pagent test", max_results: 3 }),
        fauxToolCall("web_fetch", { url: "https://example.com/reference" }),
      ], { stopReason: "toolUse" }),
      context => fauxAssistantMessage(inspect(context)),
    ]);
    return;
  }
  const code = `(async () => {
    let note = document.querySelector('#pagent-smoke');
    if (!note) {
      note = document.createElement('section');
      note.id = 'pagent-smoke';
      document.body.append(note);
    }
    note.textContent = 'The agent changed this live document.';
    let memory = document.querySelector('agent-memory');
    if (!memory) {
      memory = document.createElement('agent-memory');
      document.body.prepend(memory);
    }
    memory.textContent = 'Smoke test: the page is the workspace. Details: /info.html';
    const response = await fetch('/info.html', {
      method: 'POST', headers: {'Content-Type': 'text/html'},
      body: '<!doctype html><title>Smoke findings</title><h1>Persistent knowledge</h1><p>Written from the agent browser console.</p>'
    });
    if (!response.ok) throw new Error('Knowledge POST failed: ' + response.status);
    window.pagentSmoke = {value: 42};
    console.log('pagent console smoke');
    return {written: '/info.html', runtimeValue: window.pagentSmoke.value};
  })()`;
  fake.setResponses([
    fauxAssistantMessage([
      fauxThinking("This is a local scripted smoke test, not private model reasoning."),
      fauxToolCall("console", { code }),
    ], { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("save", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage(fauxToolCall("reload", {}), { stopReason: "toolUse" }),
    (context) => {
      const lastUser = context.messages.findLastIndex(message => message.role === "user" && (
        typeof message.content === "string" ? message.content === prompt : message.content.some(block => block.type === "text" && block.text === prompt)
      ));
      const failed = context.messages.slice(lastUser + 1).filter(message => message.role === "toolResult" && message.isError);
      return fauxAssistantMessage(failed.length
        ? `Pagent smoke failed: ${JSON.stringify(failed)}`
        : "Pagent smoke complete. I changed the live page, wrote /info.html, saved the document, and reloaded it. JavaScript scratch state was not checkpointed.");
    },
  ]);
}
