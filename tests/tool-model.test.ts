/** 工具模型的自动选择、显式选择和配置失效边界；使用假凭据，不发起网络请求。 */
import assert from "node:assert/strict";
import { configSchema, defaultConfig } from "../src/config/schema.js";
import { resolveMemoryModelAlias, resolveToolModel, resolveToolModelAlias } from "../src/llm/toolModel.js";
import { ActivityPrivacyPolicy } from "../src/activity/privacyPolicy.js";

const config = configSchema.parse({
  ...defaultConfig,
  defaultModel: "chat",
  providers: {
    test: { type: "openai", apiKey: "test-key", baseUrl: "https://api.example.test/v1" },
    missing: { type: "openai", requiresApiKey: true, apiKeyEnv: "BINY_TOOL_MODEL_TEST_MISSING_KEY", baseUrl: "https://api.example.test/v1" }
  },
  models: {
    unavailable: { provider: "missing", model: "unavailable", pricing: { inputPerMillionTokens: 0, outputPerMillionTokens: 0 } },
    cheap: { provider: "test", model: "cheap-test", pricing: { inputPerMillionTokens: 0.1, outputPerMillionTokens: 0.2 } },
    chat: { provider: "test", model: "chat-test", pricing: { inputPerMillionTokens: 2, outputPerMillionTokens: 4 } },
    unknown: { provider: "test", model: "unknown-test" }
  }
});

assert.equal(resolveToolModelAlias(config), "cheap", "自动选择可用且已知价格较低的模型");
assert.equal(resolveToolModel(config)?.modelId, "cheap-test");
assert.equal(resolveToolModelAlias({ ...config, defaultModel: "unknown" }), "cheap", "聊天模型切换不影响后台选择");
assert.equal(resolveToolModelAlias({ ...config, toolModel: "chat" }), "chat", "显式选择优先");
assert.equal(resolveToolModelAlias({ ...config, toolModel: "test/chat-test" }), "chat");
assert.equal(resolveToolModel({ ...config, toolModel: "missing-model" }), undefined, "未知配置不能静默改用其他模型");
assert.equal(resolveToolModel({ ...config, toolModel: "unavailable" }), undefined, "缺失凭据时不切换模型");
assert.equal(resolveToolModelAlias({ ...config, models: { unavailable: config.models.unavailable! } }), undefined);
const unpriced = { ...config, models: { unknown: config.models.unknown!, chat: { ...config.models.chat!, pricing: undefined } } };
assert.equal(resolveToolModelAlias(unpriced), "unknown");
assert.equal(resolveToolModelAlias({ ...unpriced, defaultModel: "unknown" }), "unknown", "无价格时按稳定配置顺序选择");
assert.equal(new ActivityPrivacyPolicy(config.activity).canAnalyzeWithModel(resolveToolModel(config)!), false, "自动选模型不能自动授予外发权限");
assert.equal(configSchema.parse({ ...config, toolModel: "cheap" }).toolModel, "cheap");
assert.equal(configSchema.safeParse({ ...config, toolModel: " " }).success, false);
const removed = configSchema.parse({ ...config, activity: { ...config.activity, analysisModel: "chat" } });
assert.equal("analysisModel" in removed.activity, false, "废弃的活动专用模型不再参与配置或选择");
assert.equal(resolveToolModelAlias(removed), "cheap");
assert.equal(resolveMemoryModelAlias(config), "cheap", "记忆留空继承自动工具模型，不跟随聊天模型");
assert.equal(resolveMemoryModelAlias({ ...config, toolModel: "unknown" }), "unknown");
const dedicatedMemory = { ...config, context: { ...config.context, memory: { ...config.context.memory, memoryModel: "chat" } } };
assert.equal(resolveMemoryModelAlias(dedicatedMemory), "chat");
assert.equal(resolveMemoryModelAlias(dedicatedMemory, "rewriteModel"), "chat");
assert.equal(resolveMemoryModelAlias({ ...dedicatedMemory, context: { ...dedicatedMemory.context, memory: { ...dedicatedMemory.context.memory, extractModel: "unknown" } } }, "extractModel"), "unknown");
assert.equal(resolveMemoryModelAlias({ ...config, toolModel: "unavailable" }), undefined, "全局选择失效不能偷偷使用聊天模型");
console.log("tool model tests passed");
