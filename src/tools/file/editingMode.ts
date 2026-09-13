/** 一次请求只选择一种编辑输入；实验开关高于已声明的原生协议。 */
import type { RegisteredTool } from "../registry.js";
import type { ToolContext } from "../types.js";
import { createReadFileTool } from "./readFile.js";
import { createEditFileTool } from "./editFile.js";
import { createApplyPatchTool } from "./applyPatch.js";
export type EditingMode = "replace" | "hashline" | "patch";

/** 先由调用方限制可用工具，再替换输入协议；patch 不能扩大原有 Write/Edit 权限集合。 */
export function routeEditingTools(entries: RegisteredTool[], context: ToolContext, mode: EditingMode): RegisteredTool[] {
  const routed = entries.map((entry) => entry.source !== "builtin" ? entry : entry.tool.name === "Read"
    ? { ...entry, tool: createReadFileTool(context, mode === "hashline") }
    : entry.tool.name === "Edit" ? { ...entry, tool: createEditFileTool(context, mode === "hashline") } : entry);
  if (mode !== "patch" || !["Write", "Edit"].every((name) => routed.some((entry) => entry.source === "builtin" && entry.tool.name === name))) return routed;
  return [...routed.filter((entry) => entry.source !== "builtin" || !["Write", "Edit"].includes(entry.tool.name)), { source: "builtin", tool: createApplyPatchTool(context) }];
}

export function resolveEditingMode(hashline: boolean | undefined, protocol: "openai-structured" | undefined): EditingMode {
  return hashline ? "hashline" : protocol === "openai-structured" ? "patch" : "replace";
}

export function resolveNativePatchProtocol(api: string, baseUrl: string, model: string, declared: "openai-structured" | "off" | undefined): "openai-structured" | undefined {
  if (api !== "responses" || declared === "off") return undefined;
  if (declared === "openai-structured") return declared;
  // 内置自动识别只覆盖官方 Responses 地址和已确认的模型族；代理端点必须自行声明。
  if (new URL(baseUrl).origin !== "https://api.openai.com") return undefined;
  return /^gpt-(?:5\.(?:1|2|4(?:-(?:mini|nano|pro))?|5|6-(?:sol|terra|luna))|6-astra)(?:-\d{4}-\d{2}-\d{2})?$/u.test(model)
    ? "openai-structured" : undefined;
}
