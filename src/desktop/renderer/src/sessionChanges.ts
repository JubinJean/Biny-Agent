/**
 * 会话级文件变更收集（右侧 dock「变更」视图的数据源）。
 *
 * 从时间线轮次里抽出 write/edit 类工具，按路径聚合成「每个文件一行」的变更记录：
 * 保留最近一次操作类型、工具调用次数、按时间拼接的合并 diff 与 ±行数，最近修改的
 * 文件排最前。unified diff 的 hunk 拆分与 ±行数统计也放在这里，聊天里的合并编辑行
 * 与 dock 变更视图共用同一份解析。
 */
import type { TimelineTool, TimelineTurn } from "./sessionTimeline.js";

export interface DiffHunkLine {
  kind: "add" | "del" | "ctx";
  text: string;
  /** 展示行号：add/ctx 用新行号，del 用旧行号。 */
  lineNo?: number;
}

export interface DiffHunk {
  oldStart: number;
  newStart: number;
  lines: DiffHunkLine[];
}

/** 把 unified diff 拆成 hunk；meta 行（diff --git/index/---/+++）不渲染，路径已在行上表达。 */
export function parseDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | undefined;
  let oldLine = 0;
  let newLine = 0;
  for (const raw of diff.split("\n")) {
    const header = /^@@(?: -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@.*)?$/u.exec(raw);
    if (header) {
      oldLine = header[1] === undefined ? 1 : Number(header[1]);
      newLine = header[2] === undefined ? 1 : Number(header[2]);
      current = { oldStart: oldLine, newStart: newLine, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith("+") && !raw.startsWith("+++")) {
      current.lines.push({ kind: "add", text: raw.slice(1), lineNo: newLine });
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      current.lines.push({ kind: "del", text: raw.slice(1), lineNo: oldLine });
      oldLine += 1;
    } else if (raw.startsWith("\\")) {
      // 「\ No newline at end of file」不占行号。
    } else {
      current.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, lineNo: newLine });
      oldLine += 1;
      newLine += 1;
    }
  }
  return hunks;
}

export function countDiffStats(diff: string): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) add += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) del += 1;
  }
  return { add, del };
}

export interface SessionFileChange {
  path: string;
  /** 该路径最近一次操作；先写后改是 edit，改完又重写是 write。 */
  operation: "write" | "edit";
  /** 该路径上的写入/编辑工具调用次数（≥2 时展示「N 次」）。 */
  changeCount: number;
  /** 各次操作的 diff 按时间顺序拼接；写入类工具可能没有 diff。 */
  diff: string;
  add: number;
  del: number;
  status: "writing" | "completed";
}

const IGNORED_STATUSES = new Set(["failed", "denied", "aborted", "cancelled", "skipped", "unknown"]);

function changeOperation(tool: TimelineTool): "write" | "edit" | undefined {
  if (tool.display?.kind === "file_io" && (tool.display.operation === "write" || tool.display.operation === "edit")) {
    return tool.display.operation;
  }
  if (tool.tool === "Write") return "write";
  if (tool.tool === "edit_file") return "edit";
  return undefined;
}

export function collectSessionChanges(turns: TimelineTurn[]): SessionFileChange[] {
  const changes = new Map<string, SessionFileChange>();
  for (const turn of turns) {
    for (const tool of turn.tools) {
      const operation = changeOperation(tool);
      const path = tool.path ?? (tool.display?.kind === "file_io" ? tool.display.path : undefined);
      if (!operation || !path || IGNORED_STATUSES.has(tool.status)) continue;
      const diff = typeof tool.diff === "string" ? tool.diff : "";
      const stats = countDiffStats(diff);
      const existing = changes.get(path);
      if (existing) {
        changes.delete(path);
        changes.set(path, {
          path,
          operation,
          changeCount: existing.changeCount + 1,
          diff: existing.diff ? `${existing.diff}\n${diff}` : diff,
          add: existing.add + stats.add,
          del: existing.del + stats.del,
          status: tool.status === "success" ? "completed" : "writing"
        });
      } else {
        changes.set(path, {
          path,
          operation,
          changeCount: 1,
          diff,
          add: stats.add,
          del: stats.del,
          status: tool.status === "success" ? "completed" : "writing"
        });
      }
    }
  }
  // Map 保序：最后写入的排在末尾，反转后最近修改的排最前。
  return [...changes.values()].reverse();
}

export interface SessionChangeTotals {
  files: number;
  writes: number;
  edits: number;
  add: number;
  del: number;
}

export function sessionChangeTotals(changes: SessionFileChange[]): SessionChangeTotals {
  const totals: SessionChangeTotals = { files: changes.length, writes: 0, edits: 0, add: 0, del: 0 };
  for (const change of changes) {
    if (change.operation === "write") totals.writes += 1;
    else totals.edits += 1;
    totals.add += change.add;
    totals.del += change.del;
  }
  return totals;
}
