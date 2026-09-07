/** 连续文件编辑合并行使用的判断和路径工具。 */
import type { TimelineTool } from "../../sessionTimeline.js";

export function isMergeableEdit(tool: TimelineTool): boolean {
  return tool.display?.kind === "file_io"
    && tool.display.operation === "edit"
    && typeof tool.diff === "string"
    && tool.diff.length > 0
    && editToolPath(tool) !== undefined
    && tool.permission === undefined;
}

export function editToolPath(tool: TimelineTool): string | undefined {
  if (tool.display?.kind === "file_io" && tool.display.path) return tool.display.path;
  return tool.path;
}
