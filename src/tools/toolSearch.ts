/**
 * 运行时工具发现模块。
 *
 * 主模型只看到当前回合的最小工具集；能力不足时可按名称、描述、来源和 capability 搜索
 * 注册表。搜索结果只用于下一模型步骤扩展 schema，真正调用仍经过统一权限与审计链。
 */
import { z } from "zod";
import { ToolAccesses } from "./access.js";
import type { RegisteredTool } from "./registry.js";
import type { Tool, ToolSource } from "./types.js";

export const toolSearchToolName = "ToolSearch";
const defaultMaxResults = 8;
const maxResults = 20;

const toolSearchSchema = z.object({
  query: z.string().trim().min(1).max(500),
  maxResults: z.number().int().min(1).max(maxResults).optional()
});

export type ToolSearchArgs = z.infer<typeof toolSearchSchema>;

export interface ToolSearchMatch {
  name: string;
  description: string;
  source: ToolSource;
  capability?: string;
}

export interface ToolSearchResult {
  tools: ToolSearchMatch[];
}

export function createToolSearchTool(getTools: () => readonly RegisteredTool[]): Tool<ToolSearchArgs, ToolSearchResult> {
  return {
    name: toolSearchToolName,
    description: "Search currently registered built-in, MCP, Skill, plugin, and subagent tools by task or capability. Matching tools become available on the next model step; call this when the current tool set cannot complete the request.",
    promptSnippet: "Discover additional registered tools when the current tool set is insufficient",
    promptGuidelines: ["Use ToolSearch only when the current tools cannot complete the request; describe the missing capability precisely"],
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", minLength: 1, maxLength: 500, description: "The missing task or capability, preferably with concrete action words." },
        maxResults: { type: "integer", minimum: 1, maximum: maxResults, description: `Maximum matches to return. Defaults to ${String(defaultMaxResults)}.` }
      },
      required: ["query"],
      additionalProperties: false
    },
    schema: toolSearchSchema,
    capability: "tools.discovery",
    risk: "read",
    resolveExecution(args) {
      return {
        accesses: ToolAccesses.none(),
        display: { kind: "generic", summary: "Search tools", detail: args.query },
        description: `Search registered tools for ${args.query}`,
        approvalRule: toolSearchToolName,
        async execute() {
          return {
            tools: getTools()
              .filter(({ tool }) => tool.name !== toolSearchToolName)
              .map(({ tool, source }) => ({
                match: { name: tool.name, description: tool.description, source, capability: tool.capability },
                score: toolSearchScore(args.query, tool.name, tool.description, source, tool.capability)
              }))
              .filter((candidate) => candidate.score > 0)
              .sort((left, right) => right.score - left.score || left.match.name.localeCompare(right.match.name))
              .slice(0, args.maxResults ?? defaultMaxResults)
              .map((candidate) => candidate.match)
          };
        }
      };
    }
  };
}

export function toolSearchResultNames(value: unknown): string[] {
  if (typeof value !== "object" || value === null || !Array.isArray((value as { tools?: unknown }).tools)) return [];
  return (value as { tools: unknown[] }).tools.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const name = (entry as { name?: unknown }).name;
    return typeof name === "string" && name.trim() ? [name] : [];
  });
}

function toolSearchScore(query: string, name: string, description: string, source: ToolSource, capability?: string): number {
  const normalizedQuery = normalize(query);
  const normalizedName = normalize(name);
  const searchable = normalize([name, description, source, capability].filter(Boolean).join(" "));
  const compactQuery = normalizedQuery.replace(/[^\p{L}\p{N}]+/gu, "");
  const compactName = normalizedName.replace(/[^\p{L}\p{N}]+/gu, "");
  let score = compactQuery === compactName ? 100 : compactName.includes(compactQuery) || compactQuery.includes(compactName) ? 40 : 0;
  for (const token of normalizedQuery.split(/[^\p{L}\p{N}_-]+/gu).filter((entry) => entry.length > 1)) {
    if (normalizedName.includes(token)) score += 12;
    else if (searchable.includes(token)) score += 4;
  }
  return score;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase();
}
