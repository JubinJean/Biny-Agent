/** 恢复历史会话后，旧预算不能覆盖当前模型容量或让 fallback 标记继续粘住。 */
import assert from "node:assert/strict";
import test from "node:test";
import { formatContextUsage, resolveContextCapacity } from "../src/desktop/renderer/src/usagePresentation.js";

test("历史 32K fallback 使用当前 1M 容量，保留已用 token", () => {
  const historical = { contextWindow: 32_768, contextWindowIsFallback: true };
  const model = { contextWindow: 1_000_000, contextWindowIsFallback: false };
  const capacity = resolveContextCapacity(undefined, model, historical)!;
  const usage = formatContextUsage({ usedTokens: 4_400, contextWindow: capacity.contextWindow!, contextWindowIsFallback: capacity.contextWindowIsFallback });
  assert.equal(usage?.percent, 0.4);
  assert.equal(usage?.contextWindowIsFallback, false);
  assert.deepEqual(historical, { contextWindow: 32_768, contextWindowIsFallback: true });
});

test("当前运行时声明优先于目录，运行时估算可由当前目录补齐", () => {
  const model = { contextWindow: 1_000_000, contextWindowIsFallback: false };
  const runtime = { contextWindow: 100_000, contextWindowIsFallback: false };
  assert.equal(resolveContextCapacity(runtime, model, undefined), runtime);
  assert.equal(resolveContextCapacity({ contextWindow: 32_768, contextWindowIsFallback: true }, model, undefined), model);
});

test("缺少当前信息时才能使用历史容量，未知容量仍保留估算标记", () => {
  const historical = { contextWindow: 32_768, contextWindowIsFallback: true };
  assert.equal(resolveContextCapacity(undefined, undefined, historical), historical);
  assert.equal(resolveContextCapacity(undefined, undefined, undefined), undefined);
  const current = { contextWindow: 32_768, contextWindowIsFallback: true };
  assert.equal(resolveContextCapacity(current, undefined, { contextWindow: 1_000_000, contextWindowIsFallback: false }), current);
});
