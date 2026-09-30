import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { recordTurnPrompts, type TurnPrompts } from "../src/turn-prompts.ts";

test("prompt evidence retains repeated run IDs independently of host receipt lifetimes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pagent-prompt-evidence-"));
  try {
    const scope = { agentId: "one", inputId: "input", runId: "reused-run" };
    const prompts: TurnPrompts = { resolvedAt: new Date().toISOString(), system: { source: null, text: "stock" }, user: { source: {kind:"raw",value:"first"},text:"first" } };
    await recordTurnPrompts(directory, scope, prompts);
    await recordTurnPrompts(directory, scope, { ...prompts, user: {source:{kind:"raw",value:"second"},text:"second"} });
    const root = join(directory, "turn-prompts");
    const names = await readdir(root);
    assert.equal(names.length, 2);
    const texts = await Promise.all(names.map(async name => {
      const record = JSON.parse(await readFile(join(root,name), "utf8")) as {runId:string;prompts:TurnPrompts};
      assert.equal(record.runId, scope.runId);
      return record.prompts.user.text;
    }));
    assert.deepEqual(texts.sort(), ["first", "second"]);
  } finally { await rm(directory, {recursive:true,force:true}); }
});
