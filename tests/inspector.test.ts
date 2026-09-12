/** 侧栏的上下文边界和只读任务契约，覆盖长输入与多行问题。 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildInspectorTask } from "../src/desktop/inspectorTask.js";
import { executeRuntimeCommand } from "../src/runtime/commands.js";
import type { CommandRuntime } from "../src/runtime/CommandRuntime.js";
import type { InteractiveRuntimeHandle } from "../src/runtime/InteractiveAgentRuntime.js";

test("侧聊保留多行正文和最近历史，超长历史不挤掉当前问题", () => {
  const task = buildInspectorTask("side-chat", "第一行\n  第二行", [
    { role: "user", content: "旧".repeat(1000) },
    { role: "assistant", content: "上一次回答" }
  ], 300);
  assert.ok(task.length <= 300);
  assert.ok(task.includes("上一次回答"));
  assert.ok(task.endsWith("第一行\n  第二行"));
  assert.ok(!task.includes("旧"));
});

test("审阅默认检查当前 Git 改动，过长问题显式失败", () => {
  assert.match(buildInspectorTask("review", "", [], 1000), /未提交改动/);
  assert.throws(() => buildInspectorTask("side-chat", "问题".repeat(1000), [], 200), /问题过长/);
});

test("Inspector 命令强制只读，任务文本不会被当作控制命令或丢失换行", async () => {
  let received = "";
  let mode: string | undefined;
  const runtime = {
    runExclusiveOperation: async (_operation: string, run: (signal: AbortSignal) => Promise<string>) => run(new AbortController().signal)
  } as unknown as InteractiveRuntimeHandle;
  const services = {
    startSubagentTask: (task: string, options: { accessMode?: string }) => {
      received = task;
      mode = options.accessMode;
      return { completion: Promise.resolve("回答") };
    }
  } as unknown as CommandRuntime;
  const result = await executeRuntimeCommand(runtime, services, "/inspect status\n  请解释这段代码", "desktop");
  assert.equal(mode, "read-only");
  assert.equal(received, "status\n  请解释这段代码");
  assert.equal(result?.content, "回答");
});
