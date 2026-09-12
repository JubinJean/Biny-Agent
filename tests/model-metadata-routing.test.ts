/** 模型事实必须跟随实际访问路径，缺失数据与用户覆盖都不能被静态目录伪装。 */
import assert from "node:assert/strict";
import test from "node:test";
import { lookupModelMetadata } from "../src/ai/modelMetadata.js";
import { defaultConfig, configSchema, type ProviderConfig } from "../src/config/schema.js";
import { providerCatalog } from "../src/desktop/renderer/src/providerCatalog.js";
import { stagedModelChoices } from "../src/desktop/renderer/src/components/settings/providerModelProjection.js";
import { ModelRuntime } from "../src/llm/ModelRuntime.js";
import { ProviderRegistry } from "../src/llm/ProviderRuntime.js";

function configFor(provider: ProviderConfig, model = "glm-5.3-flash") {
  return configSchema.parse({
    ...structuredClone(defaultConfig),
    providers: { sample: provider },
    models: { selected: { provider: "sample", model } },
    defaultModel: "selected"
  });
}

const domestic = { type: "openai-compatible", baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4" };

test("所有内置云 API 默认模型在界面和运行时都获得容量元数据", () => {
  for (const item of providerCatalog.filter((item) => item.connectionMode === "api" && item.id !== "ollama" && item.id !== "openai-compatible")) {
    const seed = item.models[0]!;
    assert.ok(seed.contextWindow && seed.contextWindow > 0, item.id);
    assert.equal(seed.contextWindowIsFallback, false, item.id);
    const runtime = new ModelRuntime(configFor({ type: item.value, baseUrl: item.baseUrl, protocol: item.protocol }, seed.id));
    const choice = runtime.listModels().find((model) => model.alias === "selected")!;
    assert.equal(choice.contextWindow, seed.contextWindow, item.id);
    assert.equal(choice.contextWindowIsFallback, false, item.id);
  }
});

test("兼容类型的官方端点可匹配元数据，未知中转和相似域名保持未知", () => {
  assert.equal(lookupModelMetadata("openai-compatible", "glm-5.3-flash", `${domestic.baseUrl}/`)?.contextWindow, 1_000_000);
  assert.equal(lookupModelMetadata("openai-compatible", "gpt-5.2", "https://api.openai.com/v1")?.contextWindow, 400_000);
  for (const url of ["https://relay.example/v1", "https://open.bigmodel.cn.evil.test/api/coding/paas/v4", "https://open.bigmodel.cn/api/unknown", `${domestic.baseUrl}?redirect=1`]) {
    assert.equal(lookupModelMetadata("openai-compatible", "glm-5.3-flash", url), undefined, url);
  }
});

test("Kimi 编程端点使用套餐模型目录，不继承普通 API 的模型", () => {
  const config = configFor({ type: "kimi", baseUrl: "https://api.kimi.com/coding/", protocol: "anthropic" }, "k3-256k");
  const provider = new ProviderRegistry(config).require("sample");
  assert.equal(provider.resolveModel(config.models.selected!).contextWindow, 262_144);
  assert.equal(provider.resolveModel({ provider: "sample", model: "k3" }).contextWindow, 1_048_576);
  assert.equal(provider.resolveModel({ provider: "sample", model: "kimi-for-coding" }).contextWindow, 1_048_576);
  assert.ok(!provider.getModels().some((model) => model.id === "kimi-k3"));
  assert.equal(lookupModelMetadata("kimi", "kimi-k3", "https://api.kimi.com/coding/"), undefined);
});

test("模型端点覆盖不继承原连接目录的窗口，订阅窗口也不套用普通 API", () => {
  const config = configFor({ type: "openai", baseUrl: "https://api.openai.com/v1" }, "gpt-5.5");
  const provider = new ProviderRegistry(config).require("sample");
  assert.equal(provider.resolveModel({ provider: "sample", model: "gpt-5.5", baseUrl: "https://chatgpt.com/backend-api/codex" }).contextWindow, 272_000);
  assert.notEqual(lookupModelMetadata("openai", "gpt-5.5")?.contextWindow, 272_000);
});

test("目录缺字段时补元数据，目录声明、模型覆盖和 profile 依次优先", () => {
  const config = configFor(domestic);
  const registry = new ProviderRegistry(config);
  const provider = registry.require("sample");
  const entry = { provider: "sample", id: "glm-5.3-flash", displayName: "GLM", capabilities: { tools: true }, reasoningEfforts: [] };
  provider.restoreModels([entry]);
  assert.equal(provider.resolveModel(config.models.selected!).contextWindow, 1_000_000);
  provider.restoreModels([{ ...entry, contextWindow: 100_000 }]);
  assert.equal(provider.resolveModel(config.models.selected!).contextWindow, 100_000);
  assert.equal(provider.resolveModel({ ...config.models.selected!, contextWindow: 80_000 }).contextWindow, 80_000);
  const profiled = configFor({ ...domestic, modelProfiles: { "glm-5.3-flash": { contextWindow: 60_000 } } });
  assert.equal(new ProviderRegistry(profiled).require("sample").resolveModel({ ...profiled.models.selected!, contextWindow: 80_000 }).contextWindow, 60_000);
});

test("未知模型继续显式使用保守预算，不把它保存成声明容量", () => {
  const config = configFor(domestic, "future-unknown-model");
  const choice = new ModelRuntime(config).listModels().find((model) => model.alias === "selected")!;
  assert.equal(choice.contextWindowIsFallback, true);
  assert.equal(config.models.selected?.contextWindow, undefined);
});

test("设置草稿补齐容量后清除 fallback，普通编辑保留原容量，换模型不继承", () => {
  const choice = new ModelRuntime(configFor(domestic, "future-unknown-model")).listModels().find((model) => model.alias === "selected")!;
  const input = { alias: "selected", displayName: "GLM", providerAlias: "sample", providerType: "openai-compatible", model: choice.model, supportsTools: true };
  const declared = stagedModelChoices([choice], [{ ...input, contextWindow: 1_000_000 }], [], {})[0]!;
  assert.equal(declared.contextWindow, 1_000_000);
  assert.equal(declared.contextWindowIsFallback, false);
  const edited = stagedModelChoices([declared], [input], [], {})[0]!;
  assert.equal(edited.contextWindow, 1_000_000);
  assert.equal(edited.contextWindowIsFallback, false);
  const changed = stagedModelChoices([declared], [{ ...input, model: "different-model" }], [], {})[0]!;
  assert.equal(changed.contextWindow, undefined);
  assert.equal(changed.contextWindowIsFallback, true);
});

test("获取只含模型 ID 的实时目录后，Runtime 仍返回已知容量并保留请求地址", async () => {
  const config = configFor({ ...domestic, apiKey: "test-key" });
  const requests: string[] = [];
  const fetcher: typeof globalThis.fetch = async (url) => {
    requests.push(String(url));
    return Response.json({ data: [{ id: "glm-5.3-flash" }] });
  };
  const runtime = new ModelRuntime(config, [], undefined, undefined, fetcher);
  await runtime.refreshModels("sample");
  assert.deepEqual(requests, [`${domestic.baseUrl}/models`]);
  const choice = runtime.listModels().find((model) => model.alias === "selected")!;
  assert.equal(choice.contextWindow, 1_000_000);
  assert.equal(choice.contextWindowIsFallback, false);
  assert.equal(config.providers.sample?.baseUrl, domestic.baseUrl);
});

test("所有服务商的当前能力优先于旧 alias，显式 profile 仍可覆盖", () => {
  for (const entry of providerCatalog) {
    const modelId = entry.models[0]?.id;
    if (!modelId || !entry.baseUrl) continue;
    const metadata = lookupModelMetadata(entry.value, modelId, entry.baseUrl);
    if (!metadata) continue;
    const config = configFor({ type: entry.value, baseUrl: entry.baseUrl }, modelId);
    config.models.selected!.capabilities = {
      vision: !metadata.capabilities.vision,
      audio: !metadata.capabilities.audio,
      tools: !metadata.capabilities.tools
    };
    const current = new ProviderRegistry(config).forModel("selected").model;
    for (const key of ["vision", "audio", "tools"] as const) {
      if (metadata.capabilities[key] !== undefined) {
        assert.equal(current.capabilities?.[key], metadata.capabilities[key], `${entry.id}: ${key}`);
      }
    }
    config.providers.sample!.modelProfiles = {
      [modelId]: { capabilities: { vision: false, tools: false } }
    };
    const overridden = new ProviderRegistry(config).forModel("selected").model;
    assert.equal(overridden.capabilities?.vision, false);
    assert.equal(overridden.capabilities?.tools, false);
  }
});

test("模型目录不保存用户能力覆盖，恢复自动后使用当前元数据", () => {
  const config = configFor({ ...domestic, modelProfiles: { "glm-5.3-flash": { capabilities: { vision: false } } } });
  const providers = new ProviderRegistry(config);
  assert.equal(providers.forModel("selected").model.capabilities?.vision, false);
  assert.equal(providers.require("sample").getModels().find((entry) => entry.id === "glm-5.3-flash")?.capabilities.vision, true);
  config.providers.sample!.modelProfiles = {};
  assert.equal(new ProviderRegistry(config).forModel("selected").model.capabilities?.vision, true);
});

test("能力草稿的空字段保持自动，手动关闭推理不被档位表重新开启", () => {
  const choice = new ModelRuntime(configFor(domestic)).listModels().find((entry) => entry.alias === "selected")!;
  const draft = stagedModelChoices([choice], [], [], {
    sample: { "glm-5.3-flash": { capabilities: { vision: undefined, reasoning: false }, thinkingLevelMap: { off: "none", high: "high" } } }
  })[0]!;
  assert.equal(draft.capabilities?.vision, true);
  assert.equal(draft.capabilities?.reasoning, false);
  assert.deepEqual(draft.efforts, []);
});

test("旧能力配置不能在解析阶段阻止启用当前模型的推理", () => {
  const config = configSchema.parse({
    ...configFor(domestic),
    models: { selected: { provider: "sample", model: "glm-5.3-flash", capabilities: { reasoning: false } } },
    thinking: { enabled: true, effort: "high" }
  });
  assert.equal(new ProviderRegistry(config).forModel("selected").model.capabilities?.reasoning, true);
});
