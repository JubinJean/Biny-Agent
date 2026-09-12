/** 辅助模型即使忽略取消，也不能拖住停止或返回迟到结果。 */
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentModel, ModelStreamEvent } from "../src/agent/core/types.js";
import { generateNativeText } from "../src/llm/nativeJson.js";

let calls = 0;
let release!: () => void;
let pending = new Promise<void>((resolve) => { release = resolve; });
const model: AgentModel = {
  provider: "test", modelId: "ignores-abort",
  stream: async () => {
    calls++;
    await pending;
    return (async function* (): AsyncGenerator<ModelStreamEvent> {
      yield { type: "text-delta", text: "late result" };
    })();
  }
};
const preaborted = new AbortController();
preaborted.abort();
await assert.rejects(generateNativeText(model, [], { signal: preaborted.signal }), { name: "AbortError" });
assert.equal(calls, 0);
const controller = new AbortController();
const result = generateNativeText(model, [], { signal: controller.signal });
controller.abort();
await assert.rejects(result, { name: "AbortError" });
release();
await delay(0);
pending = new Promise<void>((resolve) => { release = resolve; });
try {
  await assert.rejects(generateNativeText(model, [], { timeoutMs: 20 }), { name: "TimeoutError" });
} finally {
  release();
}
await delay(0);
console.log("native text cancellation tests passed");
