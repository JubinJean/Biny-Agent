/** 自动筛选的能力边界、配套工具、历史累积、显式选择和失败处理。 */
import assert from "node:assert/strict";
import { preselectCapabilities } from "../src/agent/capabilityPreselection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { defaultConfig } from "../src/config/schema.js";

let calls = 0;
let answer = JSON.stringify({ tools: ["WebSearch", "Task", "mcp_docs_read", "unavailable"], skillIds: ["review"] });
const model: AgentModel = {
  provider: "test", modelId: "selector",
  stream: async (context) => {
    calls += 1;
    assert.equal(context.tools.length, 0, "筛选阶段只产出名单，不执行工具");
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: answer };
      yield { type: "finish", reason: "stop" };
    })();
  }
};
const tools = ["Read", "Write", "WebSearch", "WebFetch", "Task", "TaskOutput", "Skill", "read_skill_resource"].map((name) => ({ name, description: name, source: "builtin" as const }));
const options = {
  input: "查看文档并评审", config: defaultConfig, history: [], previousTools: ["Read", "removed"], model,
  tools: [...tools, { name: "mcp_docs_read", description: "Read docs", source: "mcp" as const, capability: "mcp:docs" },
    { name: "mcp_docs_search", description: "Search docs", source: "mcp" as const, capability: "mcp:docs" },
    { name: "mcp_other_read", description: "Unrelated server", source: "mcp" as const, capability: "mcp:other" }],
  skills: [{ id: "review-id", name: "review", description: "Review changes" }]
};
const result = await preselectCapabilities(options);
assert.deepEqual(new Set(result.tools), new Set(["Read", "WebSearch", "WebFetch", "Task", "TaskOutput", "mcp_docs_read", "mcp_docs_search", "Skill", "read_skill_resource"]));
assert.deepEqual(result.skills, ["review-id"]);
const before = calls;
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: ["Write"], skills: "none" } }), { tools: ["Write"], skills: "none" });
assert.equal(calls, before, "显式名单不再请求辅助模型");
assert.deepEqual(await preselectCapabilities({ ...options, selection: { tools: "all", skills: "all" } }), { tools: "all", skills: "all" });
answer = JSON.stringify({ tools: [], skillIds: [] });
assert.deepEqual(await preselectCapabilities({ ...options, input: "你好", previousTools: [] }), { tools: [], skills: [] });
answer = "invalid JSON";
assert.deepEqual(await preselectCapabilities(options), { tools: ["Read"], skills: [] });
assert.deepEqual(await preselectCapabilities({ ...options, model: undefined, input: "/skill:review" }), { tools: ["Read", "Skill", "read_skill_resource"], skills: ["review-id"] });
const controller = new AbortController();
controller.abort();
await assert.rejects(preselectCapabilities({ ...options, signal: controller.signal }), { name: "AbortError" });
console.log("capability preselection tests passed");
