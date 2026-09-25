import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSystemPrompt } from "../src/prompt.ts";

for (const browser of ["chromium", "firefox"] as const) {
  test(`${browser} default prompt describes page identity, shared context, and active capabilities`, () => {
    const prompt = buildSystemPrompt(browser);
    assert.match(prompt, /window\.pagent\.collectContext selects your history/);
    assert.match(prompt, /independent models, history, and drafts/);
    assert.match(prompt, /getHTML\(\{serializableShadowRoots:true\}\)/);
    assert.match(prompt, /immediately returns a run ID, not a Promise/);
    assert.match(prompt, /preserve human drafts/);
    assert.match(prompt, /wait\(\{runs:\[runId\]\}\)/);
    assert.match(prompt, /deadlock that queue/);
    assert.match(prompt, /save writes index.html/);
    assert.match(prompt, /reload executes the stored original document/);
    assert.match(prompt, /Source: https:/);
    assert.match(prompt, /Web research tools use pi-browser/);
    assert.doesNotMatch(prompt, /with the same model/);
  });

  test(`${browser} restricted prompt does not advertise unavailable tools or resources`, () => {
    const prompt = buildSystemPrompt(browser, { tools: ["console"], http: ["GET", "HEAD"], network: "local", checkpoint: "none" });
    assert.match(prompt, /Allowed resource HTTP methods: GET, HEAD/);
    assert.match(prompt, /External sites and imports are unavailable/);
    assert.doesNotMatch(prompt, /save writes|reload executes|Source:|Web research tools|PUT or POST/);
  });
}

test("private saving and engine-specific evaluation semantics are explicit", () => {
  assert.match(buildSystemPrompt("chromium", { checkpoint: "private" }), /without changing the original index.html/);
  assert.match(buildSystemPrompt("chromium"), /REPL top-level await and let redeclaration/);
  assert.match(buildSystemPrompt("firefox"), /not bare top-level await or lexical redeclaration/);
  assert.match(buildSystemPrompt("firefox"), /restarts the workspace browser/);
});
