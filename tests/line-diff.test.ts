/**
 * lineDiff：edit 卡片的行级 diff 与 ctx 折叠。
 */
import { strict as assert } from "node:assert";
import { collapseContext, computeLineDiff } from "../src/desktop/renderer/src/lineDiff.js";

// 基本对齐：未变行保留、修改行成对出现。
{
  const entries = computeLineDiff("a\nb\nc", "a\nB\nc");
  assert.deepEqual(
    entries.map((entry) => `${entry.kind}:${entry.text}`),
    ["ctx:a", "del:b", "add:B", "ctx:c"]
  );
}

// 纯新增 / 纯删除。
{
  assert.deepEqual(computeLineDiff("", "x\ny").map((e) => e.kind), ["add", "add"]);
  assert.deepEqual(computeLineDiff("x\ny\n", "").map((e) => e.kind), ["del", "del"]);
}

// 完全相同的内容没有变更行。
{
  assert.deepEqual(computeLineDiff("same\nsame", "same\nsame").map((e) => e.kind), ["ctx", "ctx"]);
}

// ctx 折叠：远处的未变行收成 gap 计数，变更附近 ±3 行保留。
{
  const before = Array.from({ length: 20 }, (_, i) => `line${String(i)}`).join("\n");
  const after = before.replace("line10", "CHANGED");
  const collapsed = collapseContext(computeLineDiff(before, after), 3);
  const kinds = collapsed.map((entry) => entry.kind);
  assert.ok(kinds.includes("gap"), "远端未变行应折叠成 gap");
  assert.ok(kinds.includes("del") && kinds.includes("add"), "变更行必须保留");
  const keptCtx = kinds.filter((kind) => kind === "ctx").length;
  assert.equal(keptCtx, 6, "变更前后各保留 3 行 ctx");
  const gaps = collapsed.filter((entry) => entry.kind === "gap");
  assert.deepEqual(gaps.map((gap) => gap.kind === "gap" ? gap.count : 0), [7, 6], "首尾未变行各收成 gap");
}

// 超大输入退化为整删整加，不抛错。
{
  const big = Array.from({ length: 10_000 }, (_, i) => `a${String(i)}`).join("\n");
  const entries = computeLineDiff(big, `${big}\nz`);
  assert.equal(entries.filter((e) => e.kind === "ctx").length, 0);
}

console.log("lineDiff tests passed");
