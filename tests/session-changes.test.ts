/**
 * sessionChanges 测试：会话级文件变更收集（按路径合并、最近优先、失败工具剔除）、
 * 统计汇总，以及从聊天合并编辑行移过来的 unified diff hunk 解析与 ±行数统计。
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createUnifiedDiff } from "../src/utils/diff.js";
import {
  collectSessionChanges,
  countDiffStats,
  parseDiffHunks,
  sessionChangeTotals,
  type SessionFileChange
} from "../src/desktop/renderer/src/sessionChanges.js";
import { buildSessionTimeline, createSessionTimelineProjector, type TimelineTool, type TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";
import type { SessionEvent } from "../src/session/events.js";

const DIFF_A = "@@ -1,2 +1,3 @@\n-old line\n+new line\n context\n+added";
const DIFF_B = "@@ -10,1 +10,1 @@\n-typo\n+fix";

test("历史结果中的权限预览和通用输出不再投影为文件变更", () => {
  const events: SessionEvent[] = [
    { type: "user_message", content: "修改文件", time: "2026-09-13T00:00:00Z" },
    { type: "tool_call", tool: "Write", toolCallId: "write", args: { path: "a.txt", content: "proposed" }, time: "2026-09-13T00:00:01Z" },
    { type: "tool_result", tool: "Write", toolCallId: "write", result: { error: "failed", diffPreview: DIFF_A, contentPreview: "proposed", output: DIFF_B }, time: "2026-09-13T00:00:02Z" }
  ];
  const turns = buildSessionTimeline(events, []);
  assert.equal(turns[0]?.tools[0]?.diff, undefined);
  assert.equal(turns[0]?.tools[0]?.fileChange, undefined);
  assert.deepEqual(collectSessionChanges(turns), []);
  const projector = createSessionTimelineProjector();
  const projected = projector.update({ sessionId: "preview-test", events, liveEvents: [] });
  assert.equal(projected[0]?.tools[0]?.diff, undefined);
});

function tool(partial: Partial<TimelineTool>): TimelineTool {
  return {
    id: partial.id ?? "t1",
    tool: partial.tool ?? "Edit",
    args: {},
    status: partial.status ?? "success",
    updates: [],
    ...partial
  } as TimelineTool;
}

function turn(partial: Partial<TimelineTurn>, tools: TimelineTool[]): TimelineTurn {
  return {
    id: partial.id ?? "turn-1",
    user: "做点改动",
    assistant: "",
    reasoning: "",
    skills: [],
    status: "completed",
    tools,
    steps: [],
    ...partial
  } as TimelineTurn;
}

test("collectSessionChanges 按路径聚合同文件的多次编辑并拼接 diff", () => {
  const changes = collectSessionChanges([
    turn({}, [
      tool({ id: "a", diff: DIFF_A, fileChange: { operation: "update", path: "src/a.ts", committed: true, diff: DIFF_A } }),
      tool({ id: "b", diff: DIFF_B, fileChange: { operation: "update", path: "src/a.ts", committed: true, diff: DIFF_B } })
    ])
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.path, "src/a.ts");
  assert.equal(changes[0]!.operation, "update");
  assert.equal(changes[0]!.changeCount, 2);
  assert.equal(changes[0]!.add, 3);
  assert.equal(changes[0]!.del, 2);
  assert.equal(changes[0]!.status, "completed");
});

test("collectSessionChanges 直接消费统一 change，并保留删除和移动语义", () => {
  const changes = collectSessionChanges([turn({}, [
    tool({ id: "delete", fileChange: { operation: "delete", path: "old.ts", committed: true, diff: DIFF_A }, diff: DIFF_A }),
    tool({ id: "move", fileChange: { operation: "move", path: "from.ts", destinationPath: "to.ts", committed: true, diff: "" } })
  ])]);
  assert.deepEqual(changes.map((change) => [change.path, change.operation]), [["to.ts", "move"], ["old.ts", "delete"]]);
});

test("collectSessionChanges 最近修改优先，且最近一次操作决定 write/edit 归类", () => {
  const changes = collectSessionChanges([
    turn({ id: "t1" }, [tool({ id: "a", diff: DIFF_A, fileChange: { operation: "create", path: "src/a.ts", committed: true, diff: DIFF_A } })]),
    turn({ id: "t2" }, [tool({ id: "b", diff: DIFF_B, fileChange: { operation: "update", path: "src/a.ts", committed: true, diff: DIFF_B } }),
      tool({ id: "c", diff: "", fileChange: { operation: "create", path: "src/b.ts", committed: true, diff: "" } })])
  ]);
  assert.deepEqual(changes.map((change: SessionFileChange) => change.path), ["src/b.ts", "src/a.ts"]);
  const a = changes.find((change) => change.path === "src/a.ts")!;
  assert.equal(a.operation, "update");
  assert.equal(a.changeCount, 2);
});

test("collectSessionChanges 剔除失败/被拒的工具，未成功的文件标记 writing", () => {
  const changes = collectSessionChanges([
    turn({}, [
      tool({ id: "a", status: "denied", display: { kind: "file_io", operation: "write", path: "src/denied.ts" } }),
      tool({ id: "b", status: "running", diff: "", display: { kind: "file_io", operation: "write", path: "src/running.ts" } })
    ])
  ]);
  assert.deepEqual(changes.map((change) => change.path), ["src/running.ts"]);
  assert.equal(changes[0]!.status, "writing");
});

test("sessionChangeTotals 汇总文件数、写入/编辑与 ±行数", () => {
  const totals = sessionChangeTotals([
    { path: "a.ts", operation: "create", changeCount: 1, diff: DIFF_A, add: 2, del: 1, status: "completed" },
    { path: "b.ts", operation: "update", changeCount: 3, diff: DIFF_B, add: 1, del: 1, status: "completed" }
  ]);
  assert.deepEqual(totals, { files: 2, writes: 1, edits: 1, add: 3, del: 2 });
});

test("parseDiffHunks 拆 hunk 并维护双侧行号，meta 行不产出", () => {
  const hunks = parseDiffHunks(`diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -2,3 +2,2 @@\n keep\n-del\n+add\n@@ -20,1 +21,2 @@\n+tail`);
  assert.equal(hunks.length, 2);
  assert.equal(hunks[0]!.oldStart, 2);
  assert.equal(hunks[0]!.newStart, 2);
  assert.deepEqual(hunks[0]!.lines.map((line) => [line.kind, line.lineNo]), [
    ["ctx", 2], ["del", 3], ["add", 3]
  ]);
  assert.deepEqual(hunks[1]!.lines.map((line) => [line.kind, line.lineNo]), [["add", 21]]);
});

test("countDiffStats 不把 +++/--- 头算进增删行", () => {
  assert.deepEqual(countDiffStats("+++ b/x.ts\n--- a/x.ts\n+a\n-b"), { add: 1, del: 1 });
});

test("parseDiffHunks 兼容权限预览生成的轻量裸 @@ hunk", () => {
  const diff = createUnifiedDiff("src/a.ts", "old\n", "new\n");
  const hunks = parseDiffHunks(diff);
  assert.equal(hunks.length, 1);
  assert.deepEqual(hunks[0]!.lines.map((line) => [line.kind, line.text, line.lineNo]), [
    ["del", "old", 1],
    ["add", "new", 1]
  ]);
});
