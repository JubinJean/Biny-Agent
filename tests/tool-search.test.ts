/** 工具发现只返回匹配注册项，并由协调器显式扩展下一步工具白名单。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";
import { createToolSearchTool, toolSearchResultNames } from "../src/tools/toolSearch.js";

const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-tool-search-"));
await ensureAgentDirs(workspaceRoot);
let modelCalls = 0;
const model: AgentModel = {
  provider: "tool-search-test",
  modelId: "semantic-selector",
  stream: async () => {
    modelCalls += 1;
    return events([
      { type: "text-delta", text: JSON.stringify({ tools: ["calendar_events", "missing_tool", "calendar_events"], reasoning: "The request is about arranging a meeting." }) },
      { type: "finish", reason: "stop" }
    ]);
  }
};
const registry = new ToolRegistry();
registry.register(createToolSearchTool(() => registry.listEntries(), () => model));
registry.register({
  name: "calendar_events",
  description: "Read and create calendar meetings.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  schema: z.object({}),
  capability: "calendar",
  risk: "read",
  resolveExecution: () => ({ approvalRule: "calendar_events", async execute() { return { ok: true }; } })
});
registry.register({
  name: "unrelated_files",
  description: "Manage local files.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
  schema: z.object({}),
  risk: "read",
  resolveExecution: () => ({ approvalRule: "unrelated_files", async execute() { return { ok: true }; } })
});
const recorder = new SessionRecorder(workspaceRoot, "tool-search");
try {
  const coordinator = new ToolExecutionCoordinator(
    { workspaceRoot, config: defaultConfig, recorder, toolRegistry: registry },
    new PermissionManager(defaultConfig.permission),
    () => undefined,
    () => ({}),
    new Set(["ToolSearch"])
  );
  const search = coordinator.createAgentTools().find((tool) => tool.name === "ToolSearch");
  assert.ok(search);
  const result = await search.execute("search-calendar", { query: "安排明天下午的项目讨论" });
  assert.deepEqual(toolSearchResultNames(result.details), ["calendar_events"]);
  assert.equal((result.details as { found?: number }).found, 1);
  assert.deepEqual(coordinator.allowTools(toolSearchResultNames(result.details)), ["calendar_events"]);
  assert.deepEqual(new Set(coordinator.createAgentTools().map((tool) => tool.name)), new Set(["ToolSearch", "calendar_events"]));
  assert.deepEqual(coordinator.allowTools(["missing_tool"]), []);
  const cached = await search.execute("search-calendar-again", { query: "安排明天下午的项目讨论" });
  assert.deepEqual(toolSearchResultNames(cached.details), ["calendar_events"]);
  assert.equal(modelCalls, 1, "相同目录和查询应复用语义搜索缓存");
} finally {
  await recorder.close();
  await rm(workspaceRoot, { recursive: true, force: true });
}

console.log("tool search tests passed");

async function* events(items: ModelStreamEvent[]): AsyncGenerator<ModelStreamEvent, void, void> {
  for (const item of items) yield item;
}
