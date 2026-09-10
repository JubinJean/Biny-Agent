/**
 * 文件列表工具模块。
 *
 * `Glob` 复用 workspace scanner，在 ignore 规则和数量限制内返回工作区文件列表。
 * 它用于让 agent 快速获得项目轮廓，而不是完整读取文件内容。
 */
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import path from "node:path";
import { z } from "zod";
import { ToolAccesses } from "../access.js";
import type { Tool, ToolContext } from "../types.js";

export interface ListFilesArgs {
  // limit 用于保护大型仓库，避免一次性把全部文件塞进响应。
  limit?: number;
  // pattern 使用标准 glob 语法筛选相对工作区根目录的文件路径。
  pattern?: string;
}

export interface ListFilesResult {
  files: string[];
}

export function createListFilesTool(context: ToolContext): Tool<ListFilesArgs, ListFilesResult> {
  // 文件枚举统一复用 workspace scanner，保证 CLI、搜索和项目上下文的忽略规则一致。
  return {
    name: "Glob",
    description: "Expand a glob pattern to list workspace files.",
    promptSnippet: "Expand a glob pattern to list workspace files",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", minLength: 1, description: "Optional glob pattern relative to the workspace root." },
        limit: { type: "integer", minimum: 1, maximum: 1000, description: "Maximum number of matching files to return." }
      },
      required: [],
      additionalProperties: false
    },
    schema: z.object({
      pattern: z.string().min(1).optional(),
      limit: z.number().int().positive().max(1000).optional()
    }).default({}),
    capability: "filesystem.list",
    risk: "read",
    resolveExecution(args) {
      const pattern = args.pattern?.trim();
      return {
        accesses: ToolAccesses.searchTree(context.workspaceRoot),
        display: { kind: "file_io", operation: "list", path: ".", detail: pattern ?? `limit ${String(args.limit ?? 200)}` },
        description: pattern ? `Expand ${pattern}` : "List workspace files",
        approvalRule: "Glob",
        async execute({ signal }) {
          if (args.pattern !== undefined && pattern === undefined) {
            throw new Error("Glob requires a non-empty pattern.");
          }
          const files = await scanWorkspaceFiles(
            context.workspaceRoot,
            context.ignore,
            args.limit ?? 200,
            signal,
            pattern === undefined
              ? undefined
              : (relativePath) => path.matchesGlob(relativePath.split(path.sep).join("/"), pattern)
          );
          return { files };
        }
      };
    }
  };
}
