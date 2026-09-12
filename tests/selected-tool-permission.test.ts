/** 能力名单只决定可见性，不替代真实权限门禁；迟到批准不能执行或记住授权。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { ToolExecutionCoordinator } from "../src/agent/toolExecutionCoordinator.js";
import { defaultConfig } from "../src/config/schema.js";
import { PermissionManager } from "../src/permission/PermissionManager.js";
import { SessionRecorder } from "../src/session/recorder.js";
import { ensureAgentDirs } from "../src/session/store.js";

import { ToolRegistry } from "../src/tools/registry.js";
import type { AgentPermissionResult } from "../src/agent/types.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-selected-permission-"));
await ensureAgentDirs(root);
try {
  for (const mode of ["read-only", "ask"] as const) {
    const config = structuredClone(defaultConfig);
    config.permission.mode = mode;
    const permissions = new PermissionManager(config.permission);
    const recorder = new SessionRecorder(root, mode);
    const registry = new ToolRegistry();
    let executions = 0;
    let approvals = 0;
    let releaseApproval!: (result: AgentPermissionResult) => void;
    let approvalStarted!: () => void;
    const started = new Promise<void>((resolve) => { approvalStarted = resolve; });
    registry.register({
      name: "Bash", description: "No-side-effect permission stub", risk: "execute",
      parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      schema: z.object({ command: z.string() }),
      resolveExecution: () => ({ execute: async () => { executions++; return "executed"; } })
    });
    const coordinator = new ToolExecutionCoordinator({
      workspaceRoot: root, config, recorder, toolRegistry: registry,
      confirmPermission: async () => {
        approvals++;
        approvalStarted();
        return await new Promise<AgentPermissionResult>((resolve) => { releaseApproval = resolve; });
      }
    }, permissions, () => undefined, () => ({}), new Set(["Bash"]));
    const controller = new AbortController();
    const tool = coordinator.createAgentTools().find((item) => item.name === "Bash")!;
    const execution = tool.execute("selected-call", { command: "npm install" }, controller.signal);
    if (mode === "ask") {
      await started;
      controller.abort();
      releaseApproval({ approved: true, scope: "session" });
    }
    await execution;
    await coordinator.waitForIdle();
    assert.equal(executions, 0, "选中的工具也不能越过拒绝或取消");
    assert.equal(approvals, mode === "ask" ? 1 : 0);
    // 取消后的批准若被记住，下一次不会再进入 confirmPermission。
    if (mode === "ask") {
      const second = tool.execute("second-call", { command: "npm install" });
      for (let attempt = 0; approvals < 2 && attempt < 1_000; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(approvals, 2, "取消后的批准不能写入会话权限");
      releaseApproval({ approved: false });
      await second;
      assert.equal(executions, 0);
    }
    await recorder.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("selected tool permission tests passed");
