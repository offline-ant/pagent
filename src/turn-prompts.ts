import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { MAX_PROMPT_BYTES, promptText, type PromptSource } from "./agent-config.ts";
import type { PageBrowser } from "./protocol.ts";
import { atomicWrite } from "./storage.ts";

export interface ResolvedPrompt { source: PromptSource | null; text: string }
export interface TurnPrompts {
  resolvedAt: string;
  system: ResolvedPrompt;
  user: { source: PromptSource; text: string };
}

/** Resolve once, outside the provider loop. Document selectors never pierce shadow roots. */
export async function resolvePrompt(source: PromptSource, browser: PageBrowser, readResource?: (resource: string) => Promise<Buffer>): Promise<{ source: PromptSource; text: string }> {
  let text: unknown = source.value;
  if (source.kind === "url") {
    if (!readResource) throw new Error("This host cannot load prompt URL resources.");
    const bytes = await readResource(source.value);
    if (bytes.length > MAX_PROMPT_BYTES) throw new Error("Prompt resource exceeds 128 KiB.");
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } else if (source.kind === "el") {
    text = await browser.evaluateValue(`(() => {
      const selector = ${JSON.stringify(source.value)};
      let matches;
      try { matches = document.querySelectorAll(selector); }
      catch { throw new Error('Invalid prompt element selector: ' + selector); }
      if (matches.length !== 1) throw new Error('Prompt element selector must match exactly one light-DOM element: ' + selector + ' (' + matches.length + ' matches)');
      const text = matches[0].textContent;
      if (!text || !text.trim() || new TextEncoder().encode(text).length > ${MAX_PROMPT_BYTES}) throw new Error('Prompt element text must be nonempty and at most 128 KiB.');
      return text;
    })()`);
  }
  return { source: structuredClone(source), text: promptText(text) };
}

/** Prompt-only evidence survives all checkpoint policies; never replays or starts inference. */
export async function recordTurnPrompts(directory: string, scope: { agentId: string; inputId: string; runId: string }, prompts: TurnPrompts): Promise<void> {
  // Run receipts are bounded and may be reused after eviction or host restart.
  // Evidence identity must therefore be independent of the page's run ID.
  const filename = randomUUID() + ".json";
  await atomicWrite(join(directory, "turn-prompts", filename), Buffer.from(JSON.stringify({ ...scope, prompts }) + "\n"));
}
