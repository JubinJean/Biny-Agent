import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { upsertDailyMemorySection, readDailyMemorySection, readDailyMemoryNote } from "../src/activity/dailyNotes.js";
import { FileMemoryStorage, readFileMemoryPrompt } from "../src/agent/context/fileMemory.js";
import { refreshSelfReflection } from "../src/agent/context/selfReflection.js";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { BINY_AGENT_DIR_ENV } from "../src/config/paths.js";

const reflectionModel: AgentModel = {
  provider: "test",
  modelId: "reflection-test",
  runtime: "builtin-llama.cpp",
  dataResidency: "local",
  stream: async () => (async function* (): AsyncGenerator<ModelStreamEvent> {
    yield { type: "text-delta", text: "今天完成了闭环验证，并应继续保持证据驱动的整理。" };
    yield { type: "finish", reason: "stop" };
  })()
};

const root = await mkdtemp(path.join(os.tmpdir(), "biny-file-memory-"));
const previous = process.env[BINY_AGENT_DIR_ENV];
process.env[BINY_AGENT_DIR_ENV] = root;

try {
  const storage = new FileMemoryStorage({ agentDir: root });
  await storage.append("用户偏好简洁的日报。", { entryKey: "preference:daily" });
  await storage.append("用户偏好简洁的日报。", { entryKey: "preference:daily" });
  await upsertDailyMemorySection("2026-09-05", "聊天摘要", "完成了记忆链路测试。", { agentDir: root });
  await upsertDailyMemorySection("2026-09-05", "活动记录", "查看了项目面板并完成 OCR。", { agentDir: root });
  const prompt = await readFileMemoryPrompt(new Date("2026-09-05T12:00:00.000Z"), { agentDir: root });
  assert.match(prompt ?? "", /简洁的日报/u);
  assert.match(prompt ?? "", /记忆链路测试/u);

  const reflection = await refreshSelfReflection("2026-09-05", {
    agentDir: root,
    model: reflectionModel,
    now: () => new Date("2026-09-05T23:00:00.000Z")
  });
  assert.equal(reflection.written, true);
  const note = await readDailyMemoryNote("2026-09-05", { agentDir: root });
  assert.match(readDailyMemorySection(note ?? "", "自我反思") ?? "", /今天完成了闭环验证/u);

  const second = await refreshSelfReflection("2026-09-05", {
    agentDir: root,
    model: reflectionModel,
    now: () => new Date("2026-09-05T23:00:00.000Z")
  });
  assert.equal(second.reason, "up_to_date");
} finally {
  if (previous === undefined) delete process.env[BINY_AGENT_DIR_ENV];
  else process.env[BINY_AGENT_DIR_ENV] = previous;
  await rm(root, { recursive: true, force: true });
}

console.log("file memory reflection tests passed");
