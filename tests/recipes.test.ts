import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { freshRecipeSuggestions, openRecipeSuggestions, RecipeStateStore } from "../src/session/recipes.js";
import type { SessionEvent } from "../src/session/recorder.js";

async function main(): Promise<void> {
  const sessionId = "recipe-test-session";
  const events: SessionEvent[] = [
    { type: "user_message", messageId: "user-1", content: "请整理 input.xlsx，并参考 reports/summary.md。", attachments: [{ name: "input.xlsx", mimeType: "application/vnd.ms-excel", path: "attachments/input.xlsx" }] },
    { type: "tool_call", tool: "Read", toolCallId: "read-1", args: { path: "input.xlsx" } },
    { type: "tool_result", tool: "Read", toolCallId: "read-1", result: { path: "input.xlsx" }, executionStatus: "succeeded" },
    { type: "user_message", messageId: "user-2", content: "不对，按照新的口径重新整理。" },
    { type: "user_message", messageId: "user-3", content: "再改成按月份统计。" },
    { type: "user_message", messageId: "user-4", content: "继续确认前面的数据。" },
    { type: "user_message", messageId: "user-5", content: "最后检查一次。" },
    { type: "tool_call", tool: "Write", toolCallId: "write-1", args: { path: "report.md", content: "report" } },
    { type: "tool_result", tool: "Write", toolCallId: "write-1", result: { path: "report.md" }, executionStatus: "succeeded" },
    { type: "tool_call", tool: "mcp_example_export", toolCallId: "mcp-1", args: {} },
    { type: "tool_result", tool: "mcp_example_export", toolCallId: "mcp-1", result: { ok: true }, executionStatus: "succeeded" }
  ];
  const suggestions = freshRecipeSuggestions(events, sessionId);
  assert.deepEqual(suggestions.map((recipe) => recipe.id), ["repeatable-doc-task", "mcp-pipeline", "thread-to-workflow"]);
  assert.ok(suggestions.every((recipe) => !/alma|alchemy|alma:\/\//iu.test(recipe.extractPrompt)));
  assert.ok(suggestions[0]?.slots.every((slot) => slot.filled));

  const root = await mkdtemp(path.join(os.tmpdir(), "biny-recipes-"));
  try {
    const store = new RecipeStateStore(root);
    await store.set(sessionId, "repeatable-doc-task", "dismissed");
    await store.set(sessionId, "mcp-pipeline", "extracted");
    const states = await store.read(sessionId);
    assert.deepEqual(states, { "repeatable-doc-task": "dismissed", "mcp-pipeline": "extracted" });
    assert.deepEqual(openRecipeSuggestions(events, sessionId, states).map((recipe) => recipe.id), ["thread-to-workflow"]);
    await store.clear(sessionId);
    assert.deepEqual(await store.read(sessionId), {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

void main();
