/** 显式启用的 MCP 文件变更契约；远端报告始终保留服务器来源，不能作为本地文件事实。 */
import { z } from "zod";
import { assertMatchingFileChange, committedFileChangeSchema, type CommittedFileChange, type PreparedFileChange } from "../tools/file/fileChange.js";

const requestSchema = z.object({
  operation: z.enum(["create", "update", "delete", "move"]),
  path: z.string().min(1),
  to: z.string().min(1).optional(),
  operationId: z.never().optional()
}).passthrough().superRefine((args, context) => {
  if ((args.operation === "move") !== (args.to !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Only move requires to." });
  }
});

const responseSchema = z.object({
  protocol: z.literal("file-change-v1"),
  operationId: z.string().min(1),
  change: committedFileChangeSchema
}).strict();

export function prepareMcpFileChange(server: string, args: unknown): PreparedFileChange {
  const parsed = requestSchema.parse(args);
  return { operation: parsed.operation, path: parsed.path, destinationPath: parsed.to, server };
}

export function readMcpFileChange(result: unknown, operationId: string, prepared: PreparedFileChange): CommittedFileChange {
  if (typeof result !== "object" || result === null) throw new Error("Missing MCP structured result.");
  const raw = result as { isError?: boolean; structuredContent?: unknown };
  if (raw.isError) throw new Error("MCP file change returned isError; remote side effect is unconfirmed.");
  const response = responseSchema.parse(raw.structuredContent);
  if (response.operationId !== operationId) throw new Error("MCP file change operationId does not match this invocation.");
  if (response.change.server !== undefined) throw new Error("MCP server cannot supply the trusted source field.");
  const change = { ...response.change, server: prepared.server };
  assertMatchingFileChange(prepared, change);
  return change;
}
