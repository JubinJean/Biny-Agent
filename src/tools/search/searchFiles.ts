/**
 * 工作区文本搜索工具。
 *
 * Grep 支持字面量或正则、路径与 glob 过滤、上下文和结果分页；文件内容按行流式读取，
 * 不会因为大文件只搜索到固定字节前缀。命中行附带可直接交给 Edit 的 Hashline 锚点。
 */
import path from "node:path";
import { z } from "zod";
import { scanWorkspaceFiles } from "../../workspace/scanner.js";
import { resolveWorkspaceDirectory, resolveWorkspacePath, toWorkspaceRelative } from "../../workspace/resolvePath.js";
import { ToolAccesses } from "../access.js";
import { hashlineAnchor } from "../file/hashline.js";
import { visitBoundUtf8Lines } from "../file/safeFileIo.js";
import type { Tool, ToolContext } from "../types.js";

export interface SearchFilesArgs {
  query: string;
  mode?: "literal" | "regex";
  path?: string;
  glob?: string;
  caseSensitive?: boolean;
  contextLines?: number;
  offset?: number;
  limit?: number;
}

export interface SearchContextLine {
  line: number;
  text: string;
}

export interface SearchFilesMatch {
  path: string;
  line: number;
  column: number;
  anchor: string;
  text: string;
  before: SearchContextLine[];
  after: SearchContextLine[];
}

export interface SearchFilesResult {
  matches: SearchFilesMatch[];
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset?: number;
  scannedFiles: number;
  skippedFiles?: string[];
  fileLimitReached?: boolean;
}

const defaultLimit = 50;
const maxLimit = 200;
const maxScannedFiles = 10_000;

const searchSchema = z.object({
  query: z.string().min(1),
  mode: z.enum(["literal", "regex"]).optional(),
  path: z.string().min(1).optional(),
  glob: z.string().min(1).optional(),
  caseSensitive: z.boolean().optional(),
  contextLines: z.number().int().min(0).max(10).optional(),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(maxLimit).optional()
}) satisfies z.ZodType<SearchFilesArgs>;

export function createSearchFilesTool(context: ToolContext): Tool<SearchFilesArgs, SearchFilesResult> {
  return {
    name: "Grep",
    description: "Search complete UTF-8 workspace files with a literal or regular expression. Supports workspace-relative path and glob filters, case control, context lines, and offset/limit pagination. Every match includes a Hashline anchor for Edit.",
    promptSnippet: "Search workspace text with filters, context, pagination, and Edit anchors",
    promptGuidelines: [
      "Use literal mode for exact text and regex mode only when pattern syntax is needed",
      "Use path or glob to narrow broad searches; continue with nextOffset when hasMore is true",
      "A Grep anchor can be passed to Edit only while that exact file line remains unchanged"
    ],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, description: "Literal text or regular expression to search for." },
        mode: { type: "string", enum: ["literal", "regex"], description: "Search interpretation. Defaults to literal." },
        path: { type: "string", minLength: 1, description: "Workspace-relative directory to search. Defaults to the workspace root." },
        glob: { type: "string", minLength: 1, description: "Optional glob matched against workspace-relative file paths." },
        caseSensitive: { type: "boolean", description: "Whether matching is case-sensitive. Defaults to true." },
        contextLines: { type: "integer", minimum: 0, maximum: 10, description: "Lines of context before and after each match. Defaults to 0." },
        offset: { type: "integer", minimum: 0, description: "Number of matching lines to skip. Defaults to 0." },
        limit: { type: "integer", minimum: 1, maximum: maxLimit, description: `Maximum matches to return. Defaults to ${String(defaultLimit)}.` }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: searchSchema,
    capability: "filesystem.search",
    risk: "read",
    resolveExecution(args) {
      const searchRoot = resolveWorkspaceDirectory(context.workspaceRoot, args.path ?? ".", context.ignore);
      const relativeRoot = toWorkspaceRelative(context.workspaceRoot, searchRoot).split(path.sep).join("/");
      const matcher = createMatcher(args.query, args.mode ?? "literal", args.caseSensitive ?? true);
      const glob = args.glob?.trim();
      if (args.glob !== undefined && !glob) throw new Error("Grep requires a non-empty glob.");
      if (glob) path.matchesGlob("validation-path", glob);
      return {
        accesses: ToolAccesses.searchTree(searchRoot),
        display: { kind: "file_io", operation: "search", path: args.path ?? ".", detail: args.query },
        description: `Search ${args.path ?? "."} for ${args.query}`,
        approvalRule: `Grep(${args.query})`,
        async execute({ signal }) {
          signal?.throwIfAborted();
          const currentRoot = resolveWorkspaceDirectory(context.workspaceRoot, args.path ?? ".", context.ignore);
          if (currentRoot !== searchRoot) throw new Error("The search root changed after the tool call was prepared.");
          const offset = args.offset ?? 0;
          const limit = args.limit ?? defaultLimit;
          const contextLines = args.contextLines ?? 0;
          const candidates = await scanWorkspaceFiles(
            context.workspaceRoot,
            context.ignore,
            maxScannedFiles + 1,
            signal,
            (relativePath) => fileInScope(relativePath, relativeRoot, glob)
          );
          const fileLimitReached = candidates.length > maxScannedFiles;
          const matches: SearchFilesMatch[] = [];
          const skippedFiles: string[] = [];
          let matchedLines = 0;
          let scannedFiles = 0;
          let hasMore = false;
          let stopSearch = false;

          for (const file of candidates.slice(0, maxScannedFiles)) {
            signal?.throwIfAborted();
            scannedFiles += 1;
            const before: SearchContextLine[] = [];
            const pending: Array<{ match: SearchFilesMatch; remaining: number }> = [];
            const matchesBeforeFile = matches.length;
            const matchedLinesBeforeFile = matchedLines;
            const hasMoreBeforeFile: boolean = hasMore;
            try {
              await visitBoundUtf8Lines(resolveWorkspacePath(context.workspaceRoot, file, context.ignore), (line, lineNumber) => {
                for (const item of pending) {
                  if (item.remaining < 1) continue;
                  item.match.after.push({ line: lineNumber, text: line });
                  item.remaining -= 1;
                }
                const hit = matcher(line);
                if (hit !== undefined) {
                  if (matchedLines >= offset + limit) {
                    hasMore = true;
                  } else if (matchedLines >= offset) {
                    const match: SearchFilesMatch = {
                      path: file,
                      line: lineNumber,
                      column: hit + 1,
                      anchor: hashlineAnchor(line, lineNumber),
                      text: line,
                      before: [...before],
                      after: []
                    };
                    matches.push(match);
                    if (contextLines > 0) pending.push({ match, remaining: contextLines });
                  }
                  matchedLines += 1;
                }
                before.push({ line: lineNumber, text: line });
                if (before.length > contextLines) before.shift();
                if (hasMore && pending.every((item) => item.remaining === 0)) {
                  stopSearch = true;
                  return false;
                }
              }, signal);
            } catch (error) {
              if (signal?.aborted) throw error;
              matches.length = matchesBeforeFile;
              matchedLines = matchedLinesBeforeFile;
              hasMore = hasMoreBeforeFile;
              stopSearch = false;
              skippedFiles.push(file);
            }
            if (stopSearch) break;
          }

          return {
            matches,
            offset,
            limit,
            hasMore,
            nextOffset: hasMore ? offset + matches.length : undefined,
            scannedFiles,
            skippedFiles: skippedFiles.length > 0 ? skippedFiles : undefined,
            fileLimitReached: fileLimitReached || undefined
          };
        }
      };
    }
  };
}

function createMatcher(query: string, mode: "literal" | "regex", caseSensitive: boolean): (line: string) => number | undefined {
  if (mode === "regex") {
    const expression = new RegExp(query, caseSensitive ? "u" : "iu");
    return (line) => expression.exec(line)?.index;
  }
  const needle = caseSensitive ? query : query.toLocaleLowerCase();
  return (line) => {
    const index = (caseSensitive ? line : line.toLocaleLowerCase()).indexOf(needle);
    return index < 0 ? undefined : index;
  };
}

function fileInScope(relativePath: string, relativeRoot: string, glob: string | undefined): boolean {
  const normalized = relativePath.split(path.sep).join("/");
  const inRoot = relativeRoot === "." || normalized === relativeRoot || normalized.startsWith(`${relativeRoot}/`);
  return inRoot && (glob === undefined || path.matchesGlob(normalized, glob));
}
