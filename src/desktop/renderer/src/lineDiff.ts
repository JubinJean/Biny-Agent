/**
 * 行级 diff（编辑工具卡片用）。
 *
 * 纯展示需求：把 before/after 对齐成「删行 / 加行 / 未变行」流，不生成 unified diff。
 * 算法是经典的 LCS 动态规划：
 * 超长输入退化为「整段删除 + 整段新增」，避免 O(n·m) 表把长文件比较卡死。
 */

export interface LineDiffEntry {
  kind: "add" | "del" | "ctx";
  text: string;
}

/** LCS 表超过这个规模就不再逐行对齐（≈16M 单元的表）。 */
const MAX_TABLE_CELLS = 16_000_000;

export function computeLineDiff(before: string, after: string): LineDiffEntry[] {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  if (oldLines.length * newLines.length > MAX_TABLE_CELLS) {
    return [
      ...oldLines.map((text): LineDiffEntry => ({ kind: "del", text })),
      ...newLines.map((text): LineDiffEntry => ({ kind: "add", text }))
    ];
  }

  // lengths[i][j] = oldLines[i:] 与 newLines[j:] 的最长公共子序列长度。
  const oldCount = oldLines.length;
  const newCount = newLines.length;
  const lengths: number[][] = Array.from({ length: oldCount + 1 }, () => new Array<number>(newCount + 1).fill(0));
  for (let i = oldCount - 1; i >= 0; i -= 1) {
    for (let j = newCount - 1; j >= 0; j -= 1) {
      lengths[i]![j]! = oldLines[i] === newLines[j]
        ? lengths[i + 1]![j + 1]! + 1
        : Math.max(lengths[i + 1]![j]!, lengths[i]![j + 1]!);
    }
  }

  const entries: LineDiffEntry[] = [];
  let i = 0;
  let j = 0;
  while (i < oldCount && j < newCount) {
    if (oldLines[i] === newLines[j]) {
      entries.push({ kind: "ctx", text: oldLines[i]! });
      i += 1;
      j += 1;
    } else if (lengths[i + 1]![j]! >= lengths[i]![j + 1]!) {
      entries.push({ kind: "del", text: oldLines[i]! });
      i += 1;
    } else {
      entries.push({ kind: "add", text: newLines[j]! });
      j += 1;
    }
  }
  while (i < oldCount) {
    entries.push({ kind: "del", text: oldLines[i]! });
    i += 1;
  }
  while (j < newCount) {
    entries.push({ kind: "add", text: newLines[j]! });
    j += 1;
  }
  return entries;
}

/** 折叠未变行：每个连续 ctx 段只保留首尾各 `context` 行，中间收成计数。 */
export function collapseContext(entries: LineDiffEntry[], context = 3): Array<LineDiffEntry | { kind: "gap"; count: number }> {
  const keep = new Array<boolean>(entries.length).fill(false);
  const changeIndex = entries.map((entry) => entry.kind !== "ctx");
  for (let index = 0; index < entries.length; index += 1) {
    if (!changeIndex[index]) continue;
    for (let offset = -context; offset <= context; offset += 1) {
      const near = index + offset;
      if (near >= 0 && near < entries.length) keep[near] = true;
    }
  }
  const result: Array<LineDiffEntry | { kind: "gap"; count: number }> = [];
  let gap = 0;
  for (let index = 0; index < entries.length; index += 1) {
    if (keep[index]) {
      if (gap > 0) {
        result.push({ kind: "gap", count: gap });
        gap = 0;
      }
      result.push(entries[index]!);
    } else {
      gap += 1;
    }
  }
  if (gap > 0) result.push({ kind: "gap", count: gap });
  return result;
}

function splitLines(value: string): string[] {
  const lines = value.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}
