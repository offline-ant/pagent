import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { resolveEngineModel } from "../src/engine-model.ts";

async function isolatedRuntime(): Promise<ModelRuntime> {
  return ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
}

test("saved Pi model and per-model thinking apply without loading resources or writing settings", async t => {
  const runtime = await isolatedRuntime();
  const settings = SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-5",
    defaultThinkingLevel: "low", modelThinkingLevels: { "openai/gpt-5": "high" } });
  t.mock.method(ModelRuntime, "create", async () => runtime);
  const load = t.mock.method(SettingsManager, "create", (...[_cwd, _agentDir, options]: Parameters<typeof SettingsManager.create>) => {
    assert.deepEqual(options, { projectTrusted: false });
    return settings;
  });
  t.mock.method(runtime, "hasConfiguredAuth", () => true);
  const selected = await resolveEngineModel({});
  assert.equal(selected.model.provider, "openai");
  assert.equal(selected.model.id, "gpt-5");
  assert.equal(selected.thinkingLevel, "high");
  assert.equal(load.mock.callCount(), 1);
});

test("CLI model and thinking override saved defaults; model suffix overrides saved thinking", async t => {
  const runtime = await isolatedRuntime();
  t.mock.method(ModelRuntime, "create", async () => runtime);
  t.mock.method(runtime, "hasConfiguredAuth", () => true);
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultProvider: "anthropic",
    defaultModel: "does-not-exist", defaultThinkingLevel: "low", modelThinkingLevels: { "openai/gpt-5": "medium" } }));
  assert.equal((await resolveEngineModel({ model: "openai/gpt-5:high" })).thinkingLevel, "high");
  assert.equal((await resolveEngineModel({ model: "openai/gpt-5:high", thinking: "off" })).thinkingLevel, "off");
  assert.equal((await resolveEngineModel({ model: "openai/gpt-5" })).thinkingLevel, "medium");
  await assert.rejects(resolveEngineModel({ model: "openai/gpt-5", thinking: "invalid" }), /Invalid thinking level/);
});

test("no saved default uses gpt-6-astra with the authenticated provider and saved thinking", async t => {
  const runtime = await isolatedRuntime();
  t.mock.method(ModelRuntime, "create", async () => runtime);
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory({ defaultThinkingLevel: "low" }));
  const auth = t.mock.method(runtime, "hasConfiguredAuth", (provider: string) => provider === "openai-codex");
  const selected = await resolveEngineModel({});
  assert.equal(selected.model.id, "gpt-6-astra");
  assert.equal(selected.model.provider, "openai-codex");
  assert.equal(selected.thinkingLevel, "low");
  auth.mock.mockImplementation((provider: string) => provider === "openai");
  assert.equal((await resolveEngineModel({})).model.provider, "openai");
  assert.equal((await resolveEngineModel({ model: "openai/gpt-5" })).model.id, "gpt-5");
});

test("an unavailable or ambiguous fallback never silently selects another model", async t => {
  const runtime = await isolatedRuntime();
  t.mock.method(ModelRuntime, "create", async () => runtime);
  t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory());
  t.mock.method(runtime, "hasConfiguredAuth", () => true);
  await assert.rejects(resolveEngineModel({}), /gpt-6-astra.*ambiguous.*--model/);
  const other = runtime.getModel("openai", "gpt-5");
  assert(other);
  t.mock.method(runtime, "getModels", () => [other]);
  await assert.rejects(resolveEngineModel({}), /gpt-6-astra.*--model/);
});

test("missing default model or credentials fail actionably instead of selecting another provider", async t => {
  const runtime = await isolatedRuntime();
  const settings = SettingsManager.inMemory({ defaultProvider: "openai", defaultModel: "gpt-5" });
  t.mock.method(ModelRuntime, "create", async () => runtime);
  t.mock.method(SettingsManager, "create", () => settings);
  t.mock.method(runtime, "hasConfiguredAuth", () => false);
  await assert.rejects(resolveEngineModel({}), /No credentials.*openai.*Run pi.*\/login/);
  await assert.rejects(resolveEngineModel({ model: "openai/gpt-5" }), /No credentials.*\/login/);
  settings.setDefaultModel("not-a-model");
  await assert.rejects(resolveEngineModel({}), /default model.*unavailable.*--model/);
});

test("no available model instructs login; internal faux model does not read user settings", async t => {
  const runtime = await isolatedRuntime();
  t.mock.method(ModelRuntime, "create", async () => runtime);
  const load = t.mock.method(SettingsManager, "create", () => SettingsManager.inMemory());
  t.mock.method(runtime, "hasConfiguredAuth", () => false);
  await assert.rejects(resolveEngineModel({}), /Run pi.*\/login/);
  const calls = load.mock.callCount();
  const selected = await resolveEngineModel({ fake: true });
  assert(selected.fake);
  assert.equal(load.mock.callCount(), calls);
});
