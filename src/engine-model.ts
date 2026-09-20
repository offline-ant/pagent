import { ModelRuntime, resolveCliModel, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type Api,
  type FauxProviderHandle,
  type Model,
  type ModelThinkingLevel,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import { createFakeModel } from "./fake-model.ts";

export interface EngineModelOptions {
  model?: string;
  thinking?: string;
  /** Internal deterministic provider for tests, never a CLI option. */
  fake?: boolean;
}

export interface EngineModel {
  modelRuntime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  fake?: FauxProviderHandle;
}

/** Real engines share this resolved runtime; faux engines need independent response queues. */
export async function resolveEngineModel(options: EngineModelOptions): Promise<EngineModel> {
  const fake = options.fake ? createFakeModel() : undefined;
  // Read only global model preferences; do not load directory-local Pi resources/settings.
  const settings = fake ? SettingsManager.inMemory() : SettingsManager.create(process.cwd(), undefined, { projectTrusted: false });
  const errors = settings.drainErrors();
  if (errors.length) throw new Error(`Could not read Pi settings: ${errors.map(({ error }) => error.message).join("; ")}`);
  const modelRuntime = await ModelRuntime.create(fake ? {
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false,
  } : { allowModelNetwork: false });
  let model: Model<Api>;
  let thinkingLevel: ModelThinkingLevel | undefined;
  if (fake) {
    modelRuntime.registerNativeProvider(fake.provider);
    model = fake.getModel();
  } else {
    const provider = settings.getDefaultProvider();
    const id = settings.getDefaultModel();
    if (!options.model && provider && id) {
      const configured = modelRuntime.getModel(provider, id);
      if (!configured) throw new Error(`Pi's default model ${provider}/${id} is unavailable. Choose --model or save a new default with Ctrl+S in Pi's /model picker.`);
      model = configured;
    } else {
      const requested = options.model ?? "gpt-6-astra";
      const resolved = resolveCliModel({ cliModel: requested, modelRuntime });
      if (resolved.error || !resolved.model) throw new Error(`${resolved.error ?? `Unknown model: ${requested}`} Run pi and use /login, or select --model provider/model.`);
      if (resolved.warning) throw new Error(resolved.warning);
      model = resolved.model;
      thinkingLevel = resolved.thinkingLevel;
    }
  }
  if (!fake && !modelRuntime.hasConfiguredAuth(model.provider)) {
    throw new Error(`No credentials configured for ${model.provider}. Run pi and use /login, then restart Pagent.`);
  }
  thinkingLevel ??= settings.getModelThinkingLevel(model.provider, model.id) ?? settings.getDefaultThinkingLevel();
  if (options.thinking !== undefined) {
    if (!Check(Type.Union(["off", "minimal", "low", "medium", "high", "xhigh", "max"].map(value => Type.Literal(value))), options.thinking)) {
      throw new Error("Invalid thinking level. Use off, minimal, low, medium, high, xhigh, or max.");
    }
    thinkingLevel = options.thinking;
  }
  return { modelRuntime, model, thinkingLevel: thinkingLevel ?? "medium", fake };
}
