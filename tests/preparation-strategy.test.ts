/** 使用真实上下文组装验证并行记忆召回、压缩收益和停止后的状态隔离。 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { ContextMemory } from "../src/agent/context/ContextMemory.js";
import { HybridMemoryRetriever } from "../src/agent/context/HybridMemoryRetriever.js";
import { LocalMemory } from "../src/agent/context/LocalMemory.js";
import { WorkspaceContext } from "../src/agent/context/WorkspaceContext.js";

const root = await mkdtemp(path.join(os.tmpdir(), "biny-preparation-strategy-"));
let calls = 0;
let response = `## Goal\n${"summary detail ".repeat(200)}\n## Next Steps\nContinue.`;
const model: AgentModel = {
  provider: "test", modelId: "summary",
  stream: async (_context, options) => {
    calls++;
    assert.equal(options?.reasoning, "off");
    assert.equal(options?.timeoutMs, 30_000);
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: response };
    })();
  }
};
try {
  const workspace = new WorkspaceContext(root, [], 4096);
  const local = new LocalMemory(root, () => model);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let workspaceStarted = false;
  let memoryStarted = false;
  const initialize = workspace.initialize.bind(workspace);
  workspace.initialize = async (signal) => {
    workspaceStarted = true;
    await gate;
    await initialize(signal);
  };
  const retriever = new HybridMemoryRetriever({
    workspaceRoot: root,
    localMemory: {
      listMemoryEntries: async () => {
        assert.equal(workspaceStarted, true);
        memoryStarted = true;
        release();
        return { entries: [], storeRevision: 0 };
      },
      search: async () => { throw new Error("automatic recall must not use lexical fallback"); },
      recordRecallUsage: async () => undefined
    },
    getEmbeddingRuntime: async () => undefined,
    getReadOnlyVectorIndex: () => undefined,
    getThresholds: (_fingerprint, recommended) => recommended
  });
  const parallel = new ContextMemory(() => model, workspace, local, 10_000, 4096, undefined, undefined, {}, undefined, undefined, retriever);
  await parallel.prepareTurn("recall", "system", AbortSignal.timeout(1_000));
  assert.equal(memoryStarted, true, "记忆召回不等待工作区扫描完成");
  assert.equal(calls, 0);
  local.close();
  retriever.close();

  const compacting = new ContextMemory(() => model, new WorkspaceContext(root, [], 4096), undefined, 1_000, 4096, undefined, undefined, {
    keepRecentTokens: 20, maxSummaryTokens: 2_000
  });
  const original = [
    { role: "user" as const, content: "old request ".repeat(20) },
    { role: "assistant" as const, content: [{ type: "text" as const, text: "latest response" }] }
  ];
  compacting.replaceHistory(original);
  const largeSystem = "fixed system instruction ".repeat(300);
  const first = await compacting.prepareTurn("continue", largeSystem, undefined, [], false);
  assert.equal(calls, 1);
  assert.equal(first.compaction, undefined, "无收益摘要不能成为 checkpoint");
  assert.deepEqual(compacting.getHistory(), original);
  await compacting.prepareTurn("continue again", largeSystem, undefined, [], false);
  assert.equal(calls, 1, "固定上下文很大时，不反复摘要同一段无收益历史");

  response = "## Goal\nContinue.\n## Progress\nCompleted the earlier step.\n## Next Steps\nUse the retained result.";
  compacting.replaceHistory([
    { role: "user", content: "earlier completed work ".repeat(300) },
    { role: "assistant", content: [{ type: "toolCall", id: "kept", name: "Read", arguments: {} }] },
    { role: "toolResult", toolCallId: "kept", toolName: "Read", content: [{ type: "text", text: "known result" }] }
  ]);
  const reduced = await compacting.prepareTurn("continue", "system", undefined, [], false);
  assert.equal(reduced.compaction?.compacted, true);
  assert.deepEqual(compacting.getHistory().map((message) => message.role), ["assistant", "toolResult"], "保留最后一个完整工具批次");
  const after = calls;
  await compacting.prepareTurn("continue", largeSystem, undefined, [], false);
  assert.equal(calls, after, "没有更早可压缩的安全前缀时不再调用模型");
  assert.equal(await compacting.compactRunContext(compacting.getHistory()), undefined, "Provider 溢出也不能压掉最后一个完整工具批次");
  assert.equal(calls, after);

  let releaseModel!: () => void;
  const slowModel: AgentModel = { ...model, stream: async () => {
    await new Promise<void>((resolve) => { releaseModel = resolve; });
    return (async function* (): AsyncGenerator<ModelStreamEvent> { yield { type: "text-delta", text: "late summary" }; })();
  } };
  const cancelled = new ContextMemory(() => slowModel, new WorkspaceContext(root, [], 4096), undefined, 1_000, 4096);
  cancelled.replaceHistory(original);
  const before = cancelled.snapshot();
  const controller = new AbortController();
  const pending = cancelled.compact(undefined, controller.signal);
  for (let i = 0; !releaseModel && i < 1_000; i++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.ok(releaseModel!);
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  releaseModel!();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(cancelled.getHistory(), original);
  assert.equal(cancelled.snapshot().promptEpoch, before.promptEpoch);
  assert.equal(cancelled.snapshot().summary, undefined);
} finally {
  await rm(root, { recursive: true, force: true });
}
console.log("preparation strategy tests passed");
