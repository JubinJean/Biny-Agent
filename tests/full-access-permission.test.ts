/** 用无副作用的模拟 Bash 验证真实权限执行链，不执行测试命令中的删除操作。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { readSessionEvents } from "../src/session/events.js";
import { ensureAgentDirs } from "../src/session/store.js";
import { ToolRegistry } from "../src/tools/registry.js";

for (const mode of ["full-access", "ask", "auto", "read-only"] as const) {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), "biny-full-access-"));
  await ensureAgentDirs(workspaceRoot);
  const config = structuredClone(defaultConfig);
  config.permission.mode = mode;
  config.permission.criticalAlwaysAsk = true;
  let executions = 0;
  let approvals = 0;
  const registry = new ToolRegistry();
  registry.register({
    name: "Bash", description: "Permission test stub", risk: "execute",
    parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
    schema: z.object({ command: z.string() }),
    resolveExecution: () => ({ execute: async () => { executions++; return { output: "stub executed" }; } })
  });
  const recorder = new SessionRecorder(workspaceRoot);
  try {
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot, config, recorder, toolRegistry: registry,
      confirmPermission: async (request) => {
        approvals++;
        assert.equal(request.requireFullYes, true);
        assert.equal(request.canRemember, false);
        return { approved: false };
      }
    }, new PermissionManager(config.permission), () => undefined, () => ({}));
    const tool = coordinator.createAgentTools().find((item) => item.name === "Bash")!;
    await tool.execute("critical-command", { command: "rm -rf recipe-state && ls -la" });
    await coordinator.waitForIdle();
    await recorder.flush();
    assert.equal(executions, mode === "full-access" ? 1 : 0, mode);
    assert.equal(approvals, mode === "ask" || mode === "auto" ? 1 : 0, mode);
    const events = await readSessionEvents(recorder.filePath);
    assert.ok(events.some((event) => event.type === "tool_call"), "保留工具调用审计");
    assert.ok(events.some((event) => event.type === "tool_result"), "保留工具结果审计");
  } finally {
    await recorder.close();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}
console.log("full access permission execution tests passed");
