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
import type { TimelineTool, TimelineTurn } from "../src/desktop/renderer/src/sessionTimeline.js";

const DIFF_A = "@@ -1,2 +1,3 @@\n-old line\n+new line\n context\n+added";
const DIFF_B = "@@ -10,1 +10,1 @@\n-typo\n+fix";

function tool(partial: Partial<TimelineTool>): TimelineTool {
  return {
    id: partial.id ?? "t1",
    tool: partial.tool ?? "edit_file",
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
      tool({ id: "a", diff: DIFF_A, display: { kind: "file_io", operation: "edit", path: "src/a.ts" } }),
      tool({ id: "b", diff: DIFF_B, path: "src/a.ts", display: { kind: "file_io", operation: "edit", path: "src/a.ts" } })
    ])
  ]);
  assert.equal(changes.length, 1);
  assert.equal(changes[0]!.path, "src/a.ts");
  assert.equal(changes[0]!.operation, "edit");
  assert.equal(changes[0]!.changeCount, 2);
  assert.equal(changes[0]!.add, 3);
  assert.equal(changes[0]!.del, 2);
  assert.equal(changes[0]!.status, "completed");
});

test("collectSessionChanges 最近修改优先，且最近一次操作决定 write/edit 归类", () => {
  const changes = collectSessionChanges([
    turn({ id: "t1" }, [tool({ id: "a", diff: DIFF_A, display: { kind: "file_io", operation: "write", path: "src/a.ts" } })]),
    turn({ id: "t2" }, [tool({ id: "b", diff: DIFF_B, display: { kind: "file_io", operation: "edit", path: "src/a.ts" } }),
      tool({ id: "c", diff: "", display: { kind: "file_io", operation: "write", path: "src/b.ts" } })])
  ]);
  assert.deepEqual(changes.map((change: SessionFileChange) => change.path), ["src/b.ts", "src/a.ts"]);
  const a = changes.find((change) => change.path === "src/a.ts")!;
  assert.equal(a.operation, "edit");
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
    { path: "a.ts", operation: "write", changeCount: 1, diff: DIFF_A, add: 2, del: 1, status: "completed" },
    { path: "b.ts", operation: "edit", changeCount: 3, diff: DIFF_B, add: 1, del: 1, status: "completed" }
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
